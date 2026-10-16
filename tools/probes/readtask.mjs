import { readFile } from "node:fs/promises";
const tasks = JSON.parse(await readFile(process.argv[2], "utf8"));
const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
console.log(JSON.stringify(sorted.map(t => ({ id: t.id.slice(0,8), status: t.status, backend: t.backend, pid: t.providerTaskId, msg: t.message, prog: t.progress, created: t.createdAt })), null, 2));
