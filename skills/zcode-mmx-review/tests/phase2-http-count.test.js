"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { cleanEnv } = require("./support/env.js");

test("T06 synthetic HTTP count: both batches dispatch once per failed shard", { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-http-count-"));
  const counts = new Map();
  const server = http.createServer((req, res) => {
    counts.set(req.url, (counts.get(req.url) || 0) + 1);
    res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({received:true}));
  });
  const wrapper = path.join(root,"fake-wrapper.cjs");
  fs.writeFileSync(wrapper, [
    '"use strict";',
    'const fs=require("node:fs"), http=require("node:http"), crypto=require("node:crypto");',
    'const args=process.argv.slice(2), file=args[args.indexOf("--prompt-file")+1];',
    'const bytes=fs.readFileSync(file), [side,status]=bytes.toString("utf8").split(":");',
    'const idx=args.indexOf("--profile-file");',
    'const digest=b=>crypto.createHash("sha256").update(b).digest("hex");',
    'http.get({hostname:"127.0.0.1",port:Number(process.env.FAKE_PORT),path:"/"+side+"/"+status},res=>{',
    'res.resume();res.on("end",()=>{',
    'const receipt={status,complete:false,exit_code:1,cli_invoked:true,batch_attempt_id:process.env.ZMX_BATCH_ATTEMPT_ID,batch_material_sha256:digest(bytes),batch_config_sha256:idx<0?"":digest(fs.readFileSync(args[idx+1]))};',
    'if(status==="truncated"){Object.assign(receipt,{status:"ok",exit_code:0,model:"Synthetic",text:"partial",complete:false,truncated:true,signal:null});}',
    'process.stdout.write(JSON.stringify(receipt)+"\\n");process.exitCode=receipt.exit_code===0?0:1;',
    '});}).on("error",()=>{process.exitCode=1;});',
  ].join("\n"));
  try {
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const port = server.address().port;
    for (const side of ["mmx","zcode"]) {
      const files = ["quota_error","timeout","thinking_budget_exhausted","truncated","api_error"].map(status=>{
        const file=path.join(root,side+"-"+status+".txt");fs.writeFileSync(file,side+":"+status);return file;
      });
      const script=path.resolve(__dirname,"..","..",side,"scripts",side+"-batch.js");
      const child=spawn(process.execPath,[script,...files.flatMap(file=>["--prompt-file",file]),"--concurrency","1"],
        {stdio:["ignore","pipe","pipe"],env:cleanEnv({TMPDIR:root,TMP:root,TEMP:root,
          [side.toUpperCase()+"_BATCH_WRAPPER"]:wrapper,FAKE_PORT:String(port)})});
      let stdout="";child.stdout.on("data",b=>{stdout+=b;});child.stderr.resume();
      const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
      assert.equal(code,1);
      const receipt=JSON.parse(stdout);
      assert.equal(receipt.batch.retried,0);
      assert.equal(receipt.shards.length,5);
      for (const status of ["quota_error","timeout","thinking_budget_exhausted","truncated","api_error"])
        assert.equal(counts.get("/"+side+"/"+status),1);
    }
    assert.equal([...counts.values()].reduce((a,b)=>a+b,0),10);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
