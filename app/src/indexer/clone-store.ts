/**
 * Clone Store Module
 *
 * Manages the local clone store for indexed repositories.
 * Supports auto-cloning from GitHub, path resolution, and repository lifecycle.
 *
 * Clone store root: ~/.kotadb/repos/<owner>/<repo>/
 * Override: KOTADB_CLONE_STORE env var
 *
 * @module @indexer/clone-store
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, normalize, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "clone-store" });

const DEFAULT_CLONE_STORE = ".kotadb/repos";

/**
 * Get the clone store root directory.
 * Defaults to ~/.kotadb/repos
 */
export function getCloneStoreRoot(): string {
	const envPath = process.env.KOTADB_CLONE_STORE;
	if (envPath) {
		return resolve(envPath);
	}
	return join(homedir(), DEFAULT_CLONE_STORE);
}

/**
 * Resolve the local path for a repository from owner/repo format.
 *
 * @param repository - Repository in "owner/repo" format
 * @returns Resolved absolute path to the clone
 * @throws Error if repository format is invalid
 */
export function resolveLocalPath(repository: string): string {
	const parts = repository.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(
			`Invalid repository format: '${repository}'. Expected 'owner/repo'`,
		);
	}
	const [owner, repo] = parts;
	const root = getCloneStoreRoot();
	return join(root, owner, repo);
}

/**
 * Check if a repository exists in the clone store.
 *
 * @param repository - Repository in "owner/repo" format
 * @returns true if the clone exists and is a valid git directory
 */
export function isInCloneStore(repository: string): boolean {
	try {
		const localPath = resolveLocalPath(repository);
		return existsSync(join(localPath, ".git"));
	} catch {
		return false;
	}
}

/**
 * Get or create the clone store root directory.
 * Creates the directory if it doesn't exist.
 */
export function ensureCloneStoreRoot(): string {
	const root = getCloneStoreRoot();
	if (!existsSync(root)) {
		logger.info("Creating clone store root", { path: root });
		mkdirSync(root, { recursive: true });
	}
	return root;
}

/**
 * Clone a repository from GitHub.
 *
 * @param repository - Repository in "owner/repo" format
 * @param ref - Optional ref (tag, branch, or commit). Defaults to default branch (shallow clone)
 * @returns The local path where the repo was cloned
 * @throws Error if cloning fails
 */
export async function cloneRepository(
	repository: string,
	ref?: string,
): Promise<string> {
	const localPath = resolveLocalPath(repository);

	// Security: validate path has no traversal
	if (normalize(localPath) !== localPath) {
		throw new Error(`Path contains traversal characters: ${localPath}`);
	}
	if (!isAbsolute(localPath)) {
		throw new Error(`Resolved path is not absolute: ${localPath}`);
	}

	// Check if already exists
	if (existsSync(localPath)) {
		logger.warn("Repository already exists in clone store", {
			repository,
			localPath,
		});
		return localPath;
	}

	// Ensure parent directory exists
	const parentDir = join(localPath, "..");
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true });
	}

	const gitUrl = `https://github.com/${repository}.git`;
	logger.info("Cloning repository", { repository: gitUrl, localPath, ref });

	// Try to clone with specified ref first, then fall back to default branch
	let exitCode: number;
	let stdout: string;
	let stderr: string;

	if (ref) {
		// Shallow clone at specific ref (tag or branch)
		const proc = Bun.spawn({
			cmd: [
				"git",
				"clone",
				"--branch",
				ref,
				"--depth",
				"1",
				gitUrl,
				localPath,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		stdout = await new Response(proc.stdout).text();
		stderr = await new Response(proc.stderr).text();
		exitCode = await proc.exited;

		if (exitCode !== 0) {
			logger.warn("Clone with specified ref failed, trying without branch", {
				repository,
				ref,
				error: stderr,
			});
			// Clean up partial clone
			const { rmSync } = await import("node:fs");
			try {
				rmSync(localPath, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		} else {
			logger.info("Repository cloned successfully", {
				repository,
				localPath,
				ref,
			});
			return localPath;
		}
	}

	// Fallback: shallow clone without specifying branch (git will figure out default)
	const fallbackProc = Bun.spawn({
		cmd: ["git", "clone", "--depth", "1", gitUrl, localPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	stdout = await new Response(fallbackProc.stdout).text();
	stderr = await new Response(fallbackProc.stderr).text();
	exitCode = await fallbackProc.exited;

	if (exitCode !== 0) {
		const errorMsg = stderr.trim() || stdout.trim() || `git clone failed (exit ${exitCode})`;
		logger.error("Git clone failed", new Error(errorMsg), {
			repository,
			localPath,
			ref,
			exitCode,
		});
		throw new Error(`Failed to clone ${repository}: ${errorMsg}`);
	}

	logger.info("Repository cloned successfully", {
		repository,
		localPath,
		ref,
	});

	return localPath;
}

/**
 * Update a repository in the clone store by pulling latest changes.
 *
 * @param localPath - Absolute path to the cloned repository
 * @returns true if update was successful
 * @throws Error if git pull fails
 */
export async function pullRepository(localPath: string): Promise<boolean> {
	if (!existsSync(join(localPath, ".git"))) {
		throw new Error(`Not a git repository: ${localPath}`);
	}

	logger.info("Pulling latest changes", { localPath });

	// First fetch to get latest refs
	const fetchProc = Bun.spawn({
		cmd: ["git", "-C", localPath, "fetch", "--tags", "origin"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const fetchStderr = await new Response(fetchProc.stderr).text();
	const fetchExit = await fetchProc.exited;

	if (fetchExit !== 0) {
		logger.warn("Git fetch failed", { localPath, error: fetchStderr });
		return false;
	}

	// Pull the current branch
	const pullProc = Bun.spawn({
		cmd: ["git", "-C", localPath, "pull", "origin"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const pullStderr = await new Response(pullProc.stderr).text();
	const pullExit = await pullProc.exited;

	if (pullExit !== 0) {
		logger.warn("Git pull failed", { localPath, error: pullStderr });
		return false;
	}

	logger.info("Repository updated successfully", { localPath });
	return true;
}

/**
 * Get the current commit SHA for a cloned repository.
 *
 * @param localPath - Absolute path to the cloned repository
 * @returns Current commit SHA
 * @throws Error if git rev-parse fails
 */
export async function getCurrentCommit(localPath: string): Promise<string> {
	const proc = Bun.spawn({
		cmd: ["git", "-C", localPath, "rev-parse", "HEAD"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(`git rev-parse failed: ${localPath}`);
	}

	return stdout.trim();
}

/**
 * Get the default branch name for a cloned repository.
 *
 * @param localPath - Absolute path to the cloned repository
 * @returns Default branch name (e.g., "main")
 * @throws Error if unable to determine
 */
export async function getDefaultBranch(localPath: string): Promise<string> {
	// Try origin/HEAD first
	const proc = Bun.spawn({
		cmd: ["git", "-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		stdout: "pipe",
		stderr: "pipe",
	});
	let stdout = await new Response(proc.stdout).text();
	let exitCode = await proc.exited;

	if (exitCode === 0) {
		const branch = stdout.trim().replace(/^origin\//, "");
		if (branch) return branch;
	}

	// Fallback to common defaults
	for (const candidate of ["main", "master"]) {
		const verifyProc = Bun.spawn({
			cmd: ["git", "-C", localPath, "rev-parse", "--verify", candidate],
			stdout: "pipe",
			stderr: "pipe",
		});
		const verifyExit = await verifyProc.exited;
		if (verifyExit === 0) return candidate;
	}

	throw new Error(`Unable to determine default branch for: ${localPath}`);
}

/**
 * Delete a cloned repository from the clone store.
 *
 * @param repository - Repository in "owner/repo" format
 * @returns true if deletion was successful
 */
export async function deleteClone(repository: string): Promise<boolean> {
	const localPath = resolveLocalPath(repository);

	if (!existsSync(localPath)) {
		logger.warn("Clone does not exist, nothing to delete", { repository });
		return false;
	}

	const { rmSync } = await import("node:fs");
	try {
		rmSync(localPath, { recursive: true, force: true });
		logger.info("Clone deleted", { repository, localPath });
		return true;
	} catch (error) {
		logger.error("Failed to delete clone", error as Error, { repository, localPath });
		return false;
	}
}
