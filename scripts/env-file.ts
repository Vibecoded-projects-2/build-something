import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Refuses to use a local secret file unless Git ignores it and does not track it. */
export function assertPrivateFile(path: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
  } catch {
    throw new Error(`${path} is not ignored by Git. Fix .gitignore first.`);
  }
  let tracked = true;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
  } catch {
    tracked = false;
  }
  if (tracked) throw new Error(`${path} is tracked by Git. Remove it from the index first.`);
}

function serialize(value: string): string {
  if (!/[\s"#'\\]/.test(value)) return value;
  // dotenv restores \n inside double quotes but has no escape for these characters.
  if (/["\\]/.test(value)) throw new Error("Values with quotes or backslashes are not supported.");
  return `"${value.replaceAll("\n", "\\n")}"`;
}

/** Sets keys in an env file, keeping everything else, with owner-only permissions. */
export function setEnvValues(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const remaining = new Map(Object.entries(values));

  const updated = lines.map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    const value = key === undefined ? undefined : remaining.get(key);
    if (key === undefined || value === undefined) return line;
    remaining.delete(key);
    return `${key}=${serialize(value)}`;
  });

  while (updated.at(-1) === "") updated.pop();
  for (const [key, value] of remaining) updated.push(`${key}=${serialize(value)}`);

  writeFileSync(path, `${updated.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
