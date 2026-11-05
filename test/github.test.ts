import { describe, expect, it } from "vitest";
import { createGateway, splitFullName } from "../server/github.ts";

describe("splitFullName", () => {
  it("splits owner and repository", () => {
    expect(splitFullName("acme/app")).toEqual({ owner: "acme", repo: "app" });
  });

  it.each(["acme", "acme/app/extra", "/app", "acme/"])("rejects %s", (value) => {
    expect(() => splitFullName(value)).toThrow("Invalid repository name");
  });
});

describe("createGateway", () => {
  it("is null until both App credentials exist", () => {
    expect(createGateway({})).toBeNull();
    expect(createGateway({ appId: "1" })).toBeNull();
    expect(createGateway({ privateKey: "key" })).toBeNull();
  });
});
