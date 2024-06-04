import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as s3Cache from "github-actions.cache-s3";
import { S3ClientConfig } from "@aws-sdk/client-s3";
import fs from "fs";

export function reportError(e: any) {
  const { commandFailed } = e;
  if (commandFailed) {
    core.error(`Command failed: ${commandFailed.command}`);
    core.error(commandFailed.stderr);
  } else {
    core.error(`${e.stack}`);
  }
}

export async function getCmdOutput(
  cmd: string,
  args: Array<string> = [],
  options: exec.ExecOptions = {},
): Promise<string> {
  let stdout = "";
  let stderr = "";
  try {
    await exec.exec(cmd, args, {
      silent: true,
      listeners: {
        stdout(data) {
          stdout += data.toString();
        },
        stderr(data) {
          stderr += data.toString();
        },
      },
      ...options,
    });
  } catch (e) {
    (e as any).commandFailed = {
      command: `${cmd} ${args.join(" ")}`,
      stderr,
    };
    throw e;
  }
  return stdout;
}

export interface CacheProvider {
  name: string;
  cache: typeof s3Cache;
}

export function getCacheProvider(): CacheProvider {
  const cacheProvider = core.getInput("cache-provider");
  const cache = s3Cache;

  if (!cache) {
    throw new Error(`The \`cache-provider\` \`{cacheProvider}\` is not valid.`);
  }

  return {
    name: cacheProvider,
    cache: cache,
  };
}

export async function exists(path: string) {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}


export function getInputS3Bucket(): string | undefined {
  const s3BucketName = core.getInput(Inputs.AWSS3Bucket);
  return s3BucketName;
}

export function getInputS3ClientConfig(): S3ClientConfig | undefined {
  const s3BucketName = core.getInput(Inputs.AWSS3Bucket);
  if (!s3BucketName) {
      return undefined;
  }

  const s3config = {
      credentials: {
          accessKeyId:
              core.getInput(Inputs.AWSAccessKeyId) ||
              process.env["AWS_ACCESS_KEY_ID"],
          secretAccessKey:
              core.getInput(Inputs.AWSSecretAccessKey) ||
              process.env["AWS_SECRET_ACCESS_KEY"],
          sessionToken:
              core.getInput(Inputs.AWSSessionToken) ||
              process.env["AWS_SESSION_TOKEN"]
      },
      region: core.getInput(Inputs.AWSRegion) || process.env["AWS_REGION"],
      endpoint: core.getInput(Inputs.AWSEndpoint),
      bucketEndpoint: core.getBooleanInput(Inputs.AWSS3BucketEndpoint),
      forcePathStyle: core.getBooleanInput(Inputs.AWSS3ForcePathStyle)
  } as S3ClientConfig;

  core.debug("Enable S3 backend mode.");

  return s3config;
}

enum Inputs {
  AWSS3Bucket = "aws-s3-bucket",
  AWSAccessKeyId = "aws-access-key-id",
  AWSSecretAccessKey = "aws-secret-access-key",
  AWSSessionToken = "aws-session-token",
  AWSRegion = "aws-region",
  AWSEndpoint = "aws-endpoint",
  AWSS3BucketEndpoint = "aws-s3-bucket-endpoint",
  AWSS3ForcePathStyle = "aws-s3-force-path-style"
}