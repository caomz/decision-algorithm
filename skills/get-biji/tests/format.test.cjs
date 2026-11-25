'use strict';
// 回归：sync 解析与 rebuild 重建共享的三条规则。
// 1) 章节时间戳同时认 MM:SS 与 HH:MM:SS（references/检索.md 里实数据就是 [13:27]）
// 2) frontmatter 重建保持原有 YAML 语义（换行 / 反斜杠不再破坏块）
// 3) rebuild 推导的文件名与 sync 落盘的文件名一致（含同日撞名追加的计数后缀）
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {
    parseChapters, convertChapterTimestamps, parseStartTimeMs, buildTranscript,
    noteBaseName, yamlDoubleQuoted, buildSummaryMarkdown, buildTranscriptMarkdown,
}=require('../scripts/format.js');
const {saveNote}=require('../scripts/sync.js');
const {summaryFileExists}=require('../scripts/rebuild-state.js');

const root=fs.mkdtempSync(path.join(process.env.TEST_ARTIFACT_ROOT||os.tmpdir(),'get-biji-format-'));

// 还原 yamlDoubleQuoted 的转义，证明重建后的 frontmatter 能解回原值，而不只是看起来像一行
function yamlUnquote(s){
    let out='';
    for(let i=0;i<s.length;i++){
        if(s[i]!=='\\'){out+=s[i];continue;}
        const c=s[++i];
        if(c==='n')out+='\n';
        else if(c==='r')out+='\r';
        else if(c==='t')out+='\t';
        else if(c==='x'){out+=String.fromCharCode(parseInt(s.slice(i+1,i+3),16));i+=2;}
        else out+=c; // \\ 与 \" 原样还原
    }
    return out;
}

function frontmatter(md){
    const match=md.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match,'frontmatter block present');
    return match[1];
}

// 值里若混入裸换行，多出来的行不再长得像键或列表项——这正是重建要避免的破坏
function assertFrontmatterWellFormed(md){
    for(const line of frontmatter(md).split('\n')){
        assert.match(line,/^(?:[a-z_][a-z0-9_]*:(?: |$)| {2}- )/);
    }
}

test('chapter parsing accepts MM:SS and HH:MM:SS stamps',()=>{
    const chapters=parseChapters([
        '- [13:27](https://getnotes.seek:810) **开场**',
        '- [00:03:25](https://getnotes.seek:205) **第二章**',
        '- [1:05](https://getnotes.seek:65) **短章**',
    ].join('\n'));
    assert.deepEqual(chapters.map(c=>[c.timestamp,c.seconds,c.title]),[
        ['1:05',65,'短章'],
        ['00:03:25',205,'第二章'],
        ['13:27',810,'开场'],
    ]);
});

test('chapter parsing still needs the seek link and the bold title',()=>{
    assert.deepEqual(parseChapters(
        '- [13:27](https://example.com/a) **不是章节**\n'
        +'- [13:27](https://getnotes.seek:810) 没有加粗\n'
        +'## [13:27] 标题'
    ),[]);
});

test('chapter stamp conversion handles MM:SS and HH:MM:SS alike',()=>{
    const start=parseStartTimeMs('2026-03-02 10:00:00');
    const content='- [13:27](https://getnotes.seek:810) **开场**\n- [00:03:25](https://getnotes.seek:205) **第二章**';
    const converted=convertChapterTimestamps(content,start);
    assert.match(converted,/\[10:13\]\(https:\/\/getnotes\.seek:810\)/);
    assert.match(converted,/\[10:03\]\(https:\/\/getnotes\.seek:205\)/);
    assert.equal(convertChapterTimestamps(content,0),content);
});

test('MM:SS chapter headings reach the injected transcript',()=>{
    const chapters=parseChapters('- [00:10](https://getnotes.seek:10) **第一章**\n- [01:00](https://getnotes.seek:60) **第二章**');
    const data={content:JSON.stringify({sentence_list:[
        {speaker_id:0,text:'前半句',start_time:0,end_time:5000},
        {speaker_id:0,text:'后半句',start_time:20000,end_time:25000},
    ]})};
    const transcript=buildTranscript(data,chapters,0);
    assert.match(transcript,/^## \[00:10\] 第一章$/m);
    assert.match(transcript,/^## \[01:00\] 第二章$/m);
    assert.match(transcript,/\[00:20\] .*后半句/);
});

test('summary frontmatter survives newlines, quotes and backslashes',()=>{
    const note={note_id:1,title:'第一行\n第二行\\附录"C盘',source:'web',
        created_at:'2026-03-02 13:21:12',tags:[{name:'标\n签'}],topics:[{topic_name:'话\n题'}]};
    const md=buildSummaryMarkdown(note,null,null,0);
    assertFrontmatterWellFormed(md);
    const header=frontmatter(md);
    assert.equal(yamlUnquote(header.match(/^title: "(.*)"$/m)[1]),'第一行\n第二行\\附录"C盘');
    assert.match(header,/^ {2}- "标\\n签"$/m);
    assert.match(header,/^ {2}- "话\\n题"$/m);
});

test('transcript file frontmatter survives multi-line titles too',()=>{
    const md=buildTranscriptMarkdown({note_id:2,title:'a\nb',created_at:'2026-03-02 13:21:12'},'逐字稿正文','132112_x.md');
    assertFrontmatterWellFormed(md);
    assert.equal(yamlUnquote(frontmatter(md).match(/^title: "(.*)"$/m)[1]),'a\nb');
});

test('yaml escaping covers backslash, quote, tab and control characters',()=>{
    assert.equal(yamlDoubleQuoted('a\\b"c\nd\te'),'a\\\\b\\"c\\nd\\te');
    assert.equal(yamlDoubleQuoted('x\u0001y'),'x\\x01y');
    assert.equal(yamlDoubleQuoted(null),'');
});

test('rebuild derives the same file name the sync stage wrote',()=>{
    const note={note_id:3,created_at:'2026-03-02 13:21:12',title:'坏\ufffd\ufffd标题',content:'# 干净标题\n正文'};
    const dir=fs.mkdtempSync(path.join(root,'save-'));
    try{
        const result=saveNote(note,null,dir);
        assert.equal(result.summaryFilename,`${noteBaseName(note)}.md`);
        assert.equal(result.summaryFilename,'132112_干净标题.md');
        assert.equal(fs.existsSync(path.join(dir,'2026-03-02',result.summaryFilename)),true);
    }finally{
        fs.rmSync(dir,{recursive:true,force:true});
    }
});

test('naming rule falls back like the sync stage when the body has no heading',()=>{
    assert.equal(noteBaseName({created_at:'2026-03-02 13:21:12',title:'普通标题'}),'132112_普通标题');
    assert.equal(noteBaseName({created_at:'2026-03-02 13:21:12',title:''}),'132112_Untitled');
    assert.equal(noteBaseName({created_at:'2026-03-02 13:21:12',title:'长'.repeat(50)}),`132112_${'长'.repeat(40)}`);
});

test('rebuild matches collision counter suffixes but not transcript files',()=>{
    const files=new Set(['132112_笔记.md','132112_笔记_2.md','132112_笔记_3.md','132112_笔记_原文.md']);
    assert.equal(summaryFileExists(files,'132112_笔记'),true);
    assert.equal(summaryFileExists(new Set(['132112_笔记_原文.md']),'132112_笔记'),false);
    assert.equal(summaryFileExists(new Set(['132112_别的笔记.md']),'132112_笔记'),false);
    assert.equal(summaryFileExists(new Set(['132112_笔记(1)_2.md']),'132112_笔记(1)'),true);
});
