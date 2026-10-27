#!/usr/bin/env node
// Echo the actual stdin; a held turn exits when its test writes the gate file.
import { existsSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("9.9.9-test (steer-claude)");
  process.exit(0);
}
let content = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { content += chunk; });
process.stdin.on("end", () => {
  const model = process.argv[process.argv.indexOf("--model") + 1];
  if (model?.startsWith("hold:")) {
    const gate = model.slice(5);
    const timer = setInterval(() => {
      if (existsSync(gate)) process.exit(Number(readFileSync(gate, "utf8")));
    }, 10);
    setTimeout(() => { clearInterval(timer); process.exit(1); }, 5000).unref();
  }
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: content }] },
  }));
});
