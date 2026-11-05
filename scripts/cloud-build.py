#!/usr/bin/env python3
"""Archives committed source, uploads it, and starts a managed image build.

Uses `git archive`, so only committed files can reach the build. The checks here are
not a general secret scanner: make sure no credentials are tracked before running.
"""
import argparse
import subprocess
import sys
import tempfile

PRIVATE_PATHS = (".env", ".data/", ".deployment/", "terraform.tfstate")
PROJECT = "reviewgate-image"


def run(*command: str) -> str:
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True, help="Terraform output build_bucket")
    bucket = parser.parse_args().bucket

    if run("git", "status", "--porcelain", "--untracked-files=no"):
        sys.exit("Commit or discard tracked changes first.")

    tracked = run("git", "ls-files").splitlines()
    if "scripts/buildspec.yml" not in tracked:
        sys.exit("scripts/buildspec.yml must be committed.")
    private = [path for path in tracked if path != ".env.example" and path.startswith(PRIVATE_PATHS)]
    if private:
        sys.exit(f"Private paths are tracked: {', '.join(private)}")

    sha = run("git", "rev-parse", "HEAD")
    key = f"source/{sha}.zip"
    with tempfile.NamedTemporaryFile(suffix=".zip") as archive:
        run("git", "archive", "--format=zip", f"--output={archive.name}", sha)
        run("aws", "s3", "cp", "--only-show-errors", archive.name, f"s3://{bucket}/{key}")

    build_id = run(
        "aws", "codebuild", "start-build",
        "--project-name", PROJECT,
        "--source-location-override", f"{bucket}/{key}",
        "--environment-variables-override", f"name=IMAGE_TAG,value={sha},type=PLAINTEXT",
        "--query", "build.id",
        "--output", "text",
    )
    print(f"Started build {build_id} for {sha}")


if __name__ == "__main__":
    main()
