#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/asciinema-replay.mjs <ansi-transcript>");
  process.exit(2);
}

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const transcript = (await readFile(source, "utf8")).replace(/\r\n?/gu, "\n");
const lines = transcript.split(/(?<=\n)/u);

for (const line of lines) {
  const plain = line.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  if (plain.startsWith("❯ ")) {
    const tokens = line.match(/\u001b\[[0-9;]*[A-Za-z]|[\s\S]/gu) ?? [];
    for (const token of tokens) {
      process.stdout.write(token);
      if (!token.startsWith("\u001b") && token !== "\n") await delay(token === " " ? 35 : 18);
    }
    await delay(250);
    continue;
  }
  process.stdout.write(line);
  const pause = /⏸\s+(\d+)\s+segundos/u.exec(plain);
  if (pause) await delay(Number(pause[1]) * 1000);
  else if (plain.startsWith("── ")) await delay(700);
  else if (plain.trim()) await delay(35);
}

await delay(1000);
