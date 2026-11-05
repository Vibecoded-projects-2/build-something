import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { assertPrivateFile, setEnvValues } from "./env-file.ts";

const ENV_FILE = ".env.local";

assertPrivateFile(ENV_FILE);

if (existsSync(ENV_FILE)) {
  console.log(`${ENV_FILE} already exists, so it was left unchanged.`);
} else {
  copyFileSync(".env.example", ENV_FILE);
  setEnvValues(ENV_FILE, {
    ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
    GITHUB_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  });
  console.log(`Created ${ENV_FILE} with a private admin password and webhook secret.`);
  console.log("Open the file in your editor to see the password. It is not printed here.");
}
