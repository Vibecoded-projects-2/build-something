import { describe, expect, it } from "vitest";
import { applyRuntimeSecret } from "../server/secrets.ts";

describe("applyRuntimeSecret", () => {
  it("applies only allowlisted, non-empty string keys", () => {
    const env: Record<string, string | undefined> = { ADMIN_USERNAME: "existing" };
    applyRuntimeSecret(
      {
        ADMIN_PASSWORD: "from-secret",
        ADMIN_USERNAME: "",
        DATABASE_URL: 42,
        TARGET_ACCOUNT: "not-allowlisted",
        REVIEW_MODEL: "not-allowlisted",
      },
      env,
    );
    expect(env).toEqual({ ADMIN_USERNAME: "existing", ADMIN_PASSWORD: "from-secret" });
  });
});
