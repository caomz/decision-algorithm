/**
 * Get Notes Formatting Module
 *
 * Handles:
 * - Transcript formatting with chapter heading injection
 * - Summary markdown building
 */

// ============================================================
// Utility
// ============================================================

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function stripGoldQuotes(content) {
    if (!content) return '';
    return content.replace(/### ✨ 金句精选[\s\S]*?(?=###\s|##\s|$)/, '').trim();
}

function getDurationMinutes(note) {
    if (note.attachments && note.attachments.length > 0) {
        const audioDuration = note.attachments.find(a => a.duration)?.duration || 0;
        return Math.round(audioDuration / 60000);
    }
    return 0;
}

function safeName(title) {
    const cleaned = (title || 'Untitled')
        .replace(/[\/\\:*?"<>|]/g, '_')
        // Damaged titles arrive full of U+FFFD and stray control chars; macOS rejects the
        // resulting byte sequences with EILSEQ, so drop them before they reach the filename.
        .replace(/�/g, '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim();
    // Slice by code point so a surrogate pair is never split into a lone surrogate.
    return Array.from(cleaned).slice(0, 40).join('') || 'Untitled';
}

/**
 * A title damaged server-side (runs of U+FFFD from a bad encoding pass) makes an unusable
 * filename and trips EILSEQ on macOS even after cleaning. The body usually opens with a
 * clean "# Title" line, so prefer that over a broken title.
 */
function resolveTitle(note) {
    const title = note.title || '';
    const heading = (note.content || note.ref_content || '').match(/^#\s+(.+)$/m);
    if (heading && (title.includes('�') || !title.trim())) {
        return heading[1].trim();
    }
    return title;
}

/**
 * File name stem (no extension) the sync stage saves a note under: HHMMSS_<safe title>.
 * rebuild-state.js must derive the same stem from the same note fields, so this is the
 * single naming rule both stages share — otherwise rebuild marks saved notes as missing
 * and the next sync writes duplicates.
 */
function noteBaseName(note) {
    const rawTime = ((note && note.created_at) || '').split(' ')[1] || '00:00:00';
    const timeStr = rawTime.substring(0, 8).replace(/:/g, '');
    return `${timeStr}_${safeName(resolveTitle(note || {}))}`;
}

/**
 * Escape a string for use inside a YAML double-quoted scalar.
 *
 * Frontmatter is rebuilt from note fields that may contain newlines (multi-line
 * titles) or backslashes (Windows-style paths). A raw newline folds into a space
 * under YAML rules and pushes the rest of the value onto its own line, corrupting
 * the block for regex-based readers; an unescaped backslash turns `\U` and friends
 * into invalid escapes. Escaping keeps the value byte-for-byte, so rebuild keeps
 * the original YAML semantics.
 */
function yamlDoubleQuoted(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001F]/g, ch => (
            ch === '\n' ? '\\n'
                : ch === '\r' ? '\\r'
                    : ch === '\t' ? '\\t'
                        : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
        ));
}

/**
 * Parse "2026-03-02 13:21:12" → milliseconds since midnight.
 */
function parseStartTimeMs(createdAt) {
    if (!createdAt) return 0;
    const timePart = createdAt.split(' ')[1] || '00:00:00';
    const [h, m, s] = timePart.split(':').map(Number);
    return ((h * 3600) + (m * 60) + (s || 0)) * 1000;
}

/**
 * Convert relative ms offset to absolute HH:MM clock time string.
 */
function formatAbsoluteTime(relativeMs, startTimeMs) {
    const absoluteMs = startTimeMs + relativeMs;
    const totalSeconds = Math.floor(absoluteMs / 1000);
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Format a timestamp: absolute clock time if startTimeMs > 0, else relative duration.
 */
function formatTimestamp(relativeMs, startTimeMs) {
    if (startTimeMs > 0) {
        return formatAbsoluteTime(relativeMs, startTimeMs);
    }
    return formatDuration(relativeMs);
}

// ============================================================
// Chapter Parsing (from note.content markdown)
// ============================================================

/**
 * Parse chapter timestamps and titles from Get Notes' 章节概要 section.
 * Returns [{seconds, title, timestamp}] sorted by seconds.
 */
function parseChapters(content) {
    if (!content) return [];

    const chapters = [];
    // Match patterns like: [00:03:25](https://getnotes.seek:205) **title**
    // Get emits chapter stamps as MM:SS or HH:MM:SS (references/检索.md shows
    // [13:27]); the seek link's trailing number stays the authoritative offset,
    // so both shapes must parse or whole sections drop out of the transcript.
    const regex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\(https:\/\/getnotes\.seek:(\d+)\)\s+\*\*(.+?)\*\*/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        chapters.push({
            timestamp: match[1],         // "00:03:25"
            seconds: parseInt(match[2]),  // 205
            title: match[3].trim(),       // "电影、戏剧与文学的区别"
        });
    }

    chapters.sort((a, b) => a.seconds - b.seconds);
    return chapters;
}

// ============================================================
// Transcript Formatting with Chapter Injection
// ============================================================

/**
 * Build structured transcript from raw sentence data with chapter headings injected.
 *
 * @param {Object} originalData - Raw API response with .content (JSON string containing sentence_list)
 * @param {Array} chapters - Parsed chapters from parseChapters()
 * @returns {string|null} Formatted transcript markdown, or null if no data
 */
function buildTranscript(originalData, chapters, startTimeMs) {
    startTimeMs = startTimeMs || 0;
    if (!originalData || !originalData.content) return null;

    let contentObj;
    try {
        contentObj = JSON.parse(originalData.content);
    } catch (e) {
        return null;
    }

    const sentences = contentObj.sentence_list || [];
    if (sentences.length === 0) return null;

    // Step 1: Build paragraphs (group sentences by speaker + gap threshold)
    const GAP_THRESHOLD = 5000; // 5 seconds
    const paragraphs = [];
    let currentPara = null;

    for (const sentence of sentences) {
        const speakerId = sentence.speaker_id;
        const text = sentence.text || '';
        const startTime = sentence.start_time || 0;

        if (!currentPara ||
            speakerId !== currentPara.speakerId ||
            startTime - currentPara.endTime > GAP_THRESHOLD) {
            // Start new paragraph
            if (currentPara) paragraphs.push(currentPara);
            currentPara = {
                speakerId,
                startTime,
                endTime: sentence.end_time || startTime,
                texts: [text],
                sentenceStartTimes: [startTime],
            };
        } else {
            currentPara.texts.push(text);
            currentPara.sentenceStartTimes.push(startTime);
            currentPara.endTime = sentence.end_time || startTime;
        }
    }
    if (currentPara) paragraphs.push(currentPara);

    if (paragraphs.length === 0) return null;

    // Step 2: Inject chapter headings
    // For each paragraph, check if any chapter starts within its time range.
    // If a chapter starts mid-paragraph, split the paragraph at the sentence boundary.
    const outputBlocks = []; // Array of {type: 'heading'|'paragraph', ...}
    let chapterIdx = 0;

    for (const para of paragraphs) {
        // Collect chapters that start before or at this paragraph's start
        while (chapterIdx < chapters.length &&
            chapters[chapterIdx].seconds * 1000 <= para.startTime) {
            outputBlocks.push({
                type: 'heading',
                relativeMs: chapters[chapterIdx].seconds * 1000,
                title: chapters[chapterIdx].title,
            });
            chapterIdx++;
        }

        // Check if any chapters fall WITHIN this paragraph
        const midChapters = [];
        let tempIdx = chapterIdx;
        while (tempIdx < chapters.length &&
            chapters[tempIdx].seconds * 1000 < para.endTime) {
            midChapters.push({ ...chapters[tempIdx], idx: tempIdx });
            tempIdx++;
        }

        if (midChapters.length === 0) {
            // No chapter splits needed - output whole paragraph
            outputBlocks.push({
                type: 'paragraph',
                startTime: para.startTime,
                speakerId: para.speakerId,
                text: para.texts.join(''),
            });
        } else {
            // Split paragraph at chapter boundaries using sentence timestamps
            let sentenceOffset = 0;

            for (const ch of midChapters) {
                const chapterMs = ch.seconds * 1000;

                // Find the sentence index closest to this chapter's start
                let splitAt = sentenceOffset;
                for (let i = sentenceOffset; i < para.sentenceStartTimes.length; i++) {
                    if (para.sentenceStartTimes[i] >= chapterMs) {
                        splitAt = i;
                        break;
                    }
                    splitAt = i + 1;
                }

                // Output text before the split point
                if (splitAt > sentenceOffset) {
                    const segmentText = para.texts.slice(sentenceOffset, splitAt).join('');
                    if (segmentText.trim()) {
                        outputBlocks.push({
                            type: 'paragraph',
                            startTime: para.sentenceStartTimes[sentenceOffset] || para.startTime,
                            speakerId: para.speakerId,
                            text: segmentText,
                        });
                    }
                }

                // Insert chapter heading
                outputBlocks.push({
                    type: 'heading',
                    relativeMs: chapterMs,
                    title: ch.title,
                });

                sentenceOffset = splitAt;
                chapterIdx = ch.idx + 1;
            }

            // Output remaining text after last chapter split
            if (sentenceOffset < para.texts.length) {
                const remainingText = para.texts.slice(sentenceOffset).join('');
                if (remainingText.trim()) {
                    outputBlocks.push({
                        type: 'paragraph',
                        startTime: para.sentenceStartTimes[sentenceOffset] || para.startTime,
                        speakerId: para.speakerId,
                        text: remainingText,
                    });
                }
            }
        }
    }

    // Emit any remaining chapters (after last paragraph)
    while (chapterIdx < chapters.length) {
        outputBlocks.push({
            type: 'heading',
            relativeMs: chapters[chapterIdx].seconds * 1000,
            title: chapters[chapterIdx].title,
        });
        chapterIdx++;
    }

    // Step 3: Render to markdown
    let result = '';
    for (const block of outputBlocks) {
        if (block.type === 'heading') {
            const ts = formatTimestamp(block.relativeMs, startTimeMs);
            result += `\n## [${ts}] ${block.title}\n\n`;
        } else {
            const ts = formatTimestamp(block.startTime, startTimeMs);
            const label = block.speakerId !== null && block.speakerId !== undefined
                ? `**${SPEAKER_LABELS[block.speakerId] || '(' + (block.speakerId + 1) + ')'}**` : '';
            result += `[${ts}] ${label} ${block.text}\n\n`;
        }
    }

    return result.trim();
}

/**
 * Build a plain transcript (no chapter injection) for notes without chapter data.
 */
function buildPlainTranscript(originalData, startTimeMs) {
    return buildTranscript(originalData, [], startTimeMs || 0);
}

/**
 * Convert chapter timestamps in summary content from relative to absolute clock time.
 * Transforms [MM:SS](https://getnotes.seek:N) / [HH:MM:SS](https://getnotes.seek:N)
 * → [HH:MM](https://getnotes.seek:N)
 */
function convertChapterTimestamps(content, startTimeMs) {
    if (!content || !startTimeMs) return content;
    return content.replace(
        /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\(https:\/\/getnotes\.seek:(\d+)\)/g,
        (match, _relTime, seekSeconds) => {
            const relativeMs = parseInt(seekSeconds) * 1000;
            const absTime = formatAbsoluteTime(relativeMs, startTimeMs);
            return `[${absTime}](https://getnotes.seek:${seekSeconds})`;
        }
    );
}

// ============================================================
// Markdown File Building
// ============================================================

const SPEAKER_LABELS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
const INLINE_THRESHOLD = 50; // lines - below this, inline transcript in summary

/**
 * Build summary markdown content for a note.
 */
function buildSummaryMarkdown(note, transcript, transcriptFilename, startTimeMs) {
    const createdDate = note.created_at || '';
    const dateStr = createdDate.split(' ')[0] || 'unknown-date';
    const timeStr = (createdDate.split(' ')[1] || '').substring(0, 5);
    const durationMin = getDurationMinutes(note);
    // ref-type notes split their body across two fields: content (the AI summary) and
    // ref_content (the source text). Both belong in the file.
    let body = note.content || '';
    if (note.ref_content && note.ref_content !== note.content) {
        body = `${body ? `${body}\n\n` : ''}## 参考内容 / 附录\n\n${note.ref_content}`;
    }
    const content = convertChapterTimestamps(body, startTimeMs || 0);

    let md = `---\n`;
    md += `date: ${dateStr}\n`;
    md += `time: "${yamlDoubleQuoted(timeStr)}"\n`;
    md += `title: "${yamlDoubleQuoted(note.title || 'Untitled')}"\n`;
    md += `note_id: ${note.note_id}\n`;
    if (note.note_type) md += `note_type: ${note.note_type}\n`;
    if (note.source) md += `source: "${yamlDoubleQuoted(note.source)}"\n`;
    if (note.created_at) md += `created_at: "${yamlDoubleQuoted(note.created_at)}"\n`;
    if (note.updated_at) md += `updated_at: "${yamlDoubleQuoted(note.updated_at)}"\n`;
    md += yamlList('tags', note.tags, 'name');
    md += yamlList('topics', note.topics, 'topic_name', 'name');
    if (durationMin > 0) md += `duration_min: ${durationMin}\n`;
    if (transcriptFilename) md += `transcript: "${yamlDoubleQuoted(transcriptFilename)}"\n`;
    md += `---\n\n`;

    if (content) md += `${content}\n\n`;

    if (note.attachments && note.attachments.length > 0) {
        md += `## 附件\n\n`;
        note.attachments.forEach(att => {
            const url = att.url || att.attach_url || att.link;
            const duration = att.duration ? ` (${Math.round(att.duration / 60000)} min)` : '';
            if (url) md += `- [audio${duration}](${url})\n`;
        });
        md += `\n`;
    }

    // Inline transcript for short notes
    if (transcript && !transcriptFilename) {
        md += `## 原文\n\n${transcript}\n`;
    }

    return md;
}

/**
 * Build transcript file markdown.
 */
function buildTranscriptMarkdown(note, transcript, summaryFilename) {
    const createdDate = note.created_at || '';
    const dateStr = createdDate.split(' ')[0] || 'unknown-date';

    let md = `---\n`;
    md += `date: ${dateStr}\n`;
    md += `note_id: ${note.note_id}\n`;
    md += `title: "${yamlDoubleQuoted(note.title || 'Untitled')}"\n`;
    if (note.note_type) md += `note_type: ${note.note_type}\n`;
    if (note.source) md += `source: "${yamlDoubleQuoted(note.source)}"\n`;
    if (note.created_at) md += `created_at: "${yamlDoubleQuoted(note.created_at)}"\n`;
    if (note.updated_at) md += `updated_at: "${yamlDoubleQuoted(note.updated_at)}"\n`;
    md += yamlList('tags', note.tags, 'name');
    md += yamlList('topics', note.topics, 'topic_name', 'name');
    if (summaryFilename) md += `summary: "${yamlDoubleQuoted(summaryFilename)}"\n`;
    md += `---\n\n`;
    md += `${transcript}\n`;

    return md;
}

/**
 * Determine whether a transcript should be in a separate file or inlined.
 * Returns true if separate file needed.
 */
function needsSeparateTranscript(transcript) {
    if (!transcript) return false;
    const lines = transcript.split('\n').length;
    return lines >= INLINE_THRESHOLD;
}

/**
 * Render a YAML list of strings from an array of API objects (or plain strings).
 * Tags arrive as {name}, topics as {topic_name} in detail payloads and as
 * {name} in list payloads, so several candidate fields are accepted.
 */
function yamlList(key, items, ...nameFields) {
    const values = (Array.isArray(items) ? items : [])
        .map(item => {
            if (typeof item === 'string') return item;
            if (!item) return null;
            for (const field of nameFields) {
                if (item[field]) return item[field];
            }
            return null;
        })
        .filter(Boolean)
        .map(String);
    if (!values.length) return '';
    return `${key}:\n${values.map(v => `  - "${yamlDoubleQuoted(v)}"`).join('\n')}\n`;
}

module.exports = {
    formatDuration,
    parseStartTimeMs,
    formatAbsoluteTime,
    formatTimestamp,
    stripGoldQuotes,
    getDurationMinutes,
    safeName,
    resolveTitle,
    noteBaseName,
    yamlDoubleQuoted,
    parseChapters,
    buildTranscript,
    buildPlainTranscript,
    convertChapterTimestamps,
    needsSeparateTranscript,
    buildSummaryMarkdown,
    buildTranscriptMarkdown,
};
