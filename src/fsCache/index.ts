import * as core from "@actions/core";
import * as path from "path";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions, UploadOptions } from "@actions/cache/lib/options";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as crypto from "crypto";
import * as fs from "fs";
import { readdir } from "fs/promises";

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 512) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

/**
 * isFeatureAvailable to check the presence of Actions cache service
 *
 * @returns boolean return true if Actions cache service feature is available, otherwise false
 */

export function isFeatureAvailable(): boolean {
    return true;
}

const cacheDir: string =
    process.env.RUST_CACHE_DIR || "/runner/rust_cache";
// const cacheDir: string =
//     process.env.INF_RUNNER_CACHE_DIR || "/var/local/inf_runner_cache";

const versionSalt = "1.0";

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    _options?: DownloadOptions,
    enableCrossOsArchive = false
): Promise<string | undefined> {
    checkPaths(paths);

    restoreKeys = restoreKeys || [];
    const keys = [primaryKey, ...restoreKeys];

    core.debug("Resolved Keys:");
    core.debug(JSON.stringify(keys));

    if (keys.length > 10) {
        throw new ValidationError(
            `Key Validation Error: Keys are limited to a maximum of 10.`
        );
    }
    for (const key of keys) {
        checkKey(key);
    }

    const compressionMethod = await utils.getCompressionMethod();
    try {
        // path are needed to compute version
        const restoreKey = await getRestoreKey(keys, paths, {
            compressionMethod,
            enableCrossOsArchive
        });


        core.debug(`Cache entry: ${restoreKey}`);

        if (restoreKey == null) {
            throw "cache entry not found";
        }

        const prefix = getPrefix(paths, {
            compressionMethod,
            enableCrossOsArchive
        });

        const archiveFolder = [cacheDir, prefix, restoreKey].join('/');

        const archivePath = path.join(
            archiveFolder,
            utils.getCacheFileName(compressionMethod)
        );

        core.debug(`Archive Path: ${archivePath}`);

        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }

        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored successfully");

        return restoreKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else {
            // Supress all non-validation cache related errors because caching should be optional
            core.warning(`Failed to restore: ${(error as Error).message}`);
        }
    }

    return undefined;
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
 * @param options cache upload options
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(
    paths: string[],
    key: string,
    _options?: UploadOptions,
    enableCrossOsArchive = false
): Promise<number> {
    checkPaths(paths);
    checkKey(key);

    const compressionMethod = await utils.getCompressionMethod();
    let cacheId = -1;

    const cachePaths = await utils.resolvePaths(paths);
    core.debug("Cache Paths:");
    core.debug(`${JSON.stringify(cachePaths)}`);

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    const prefix = getPrefix(paths, {
        compressionMethod,
        enableCrossOsArchive
    });

    const archiveFolder = path.join(
        cacheDir,
        prefix,
        key
    );

    await fs.promises.mkdir(archiveFolder, { recursive: true });

    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    );

    core.debug(`Archive archiveFolder: ${archiveFolder}`);
    core.debug(`Archive Path: ${archivePath}`);

    // Delete existing tar
    try {
        await utils.unlinkFile(archivePath);
        core.debug(`Deleted existing tar`);
    
    } catch (error) {}

    try {
        await createTar(archiveFolder, cachePaths, compressionMethod);
        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }
        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.debug(`File Size: ${archiveFileSize}`);

        // dummy cacheId, if we get there without raising, it means the cache has been saved
        cacheId = 1;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            core.warning(`Failed to save: ${typedError.message}`);
        }
    } finally {
        // Try to delete the archive to save space
        try {
            const manifestPath = path.join(
                archiveFolder,
                "manifest.txt"
            );
            await utils.unlinkFile(manifestPath);
        } catch (error) {
            core.debug(`Failed to delete manifest: ${error}`);
        }
    }

    return cacheId;
}

function getPrefix(
    paths: string[],
    { compressionMethod, enableCrossOsArchive }
): string {
    const repository = process.env.GITHUB_REPOSITORY;
    const version = getCacheVersion(
        paths,
        compressionMethod,
        enableCrossOsArchive
    );

    return ["cache", repository, version].join("/");
}

export function getCacheVersion(
    paths: string[],
    compressionMethod?: CompressionMethod,
    enableCrossOsArchive = false
): string {
    // don't pass changes upstream
    const components = paths.slice();

    // Add compression method to cache version to restore
    // compressed cache as per compression method
    if (compressionMethod) {
        components.push(compressionMethod);
    }

    // Only check for windows platforms if enableCrossOsArchive is false
    if (process.platform === "win32" && !enableCrossOsArchive) {
        components.push("windows-only");
    }

    // Add salt to cache version to support breaking changes in cache entry
    components.push(versionSalt);

    return crypto
        .createHash("sha256")
        .update(components.join("|"))
        .digest("hex");
}

export async function getRestoreKey(
    keys,
    paths,
    { compressionMethod, enableCrossOsArchive }
): Promise<string | null> {
    let restoreKey: string | null = null;

    // Find the most recent key matching one of the restoreKeys prefixes
    for (const restoreKey of keys) {
        const prefix = getPrefix(paths, {
            compressionMethod,
            enableCrossOsArchive
        });
        const restoreDir = [cacheDir, prefix, restoreKey].join("/");

        try {
            const files = await readdir(restoreDir);
            console.info(
                "reading files ",
                files
            );

            if (files.length > 0) {
                // Sort keys by LastModified time in descending order
                // const _sortedKeys = files.sort(
                //     (a, b) => {
                //         const aFileStat = fs.statSync([restoreDir, a].join('/'));
                //         const bFileStat = fs.statSync([restoreDir, b].join('/'));
                //         return Number(aFileStat.mtimeMs) - Number(bFileStat.mtimeMs)
                //     }
                // );
                console.info(
                    `Cache found with prefix ${restoreKey}`
                );
                return restoreKey;
            }
        } catch (error) {
            console.info(
                `Cache not found with prefix ${restoreKey}`
            );
        }
    }

    return restoreKey; // No keys found
}
