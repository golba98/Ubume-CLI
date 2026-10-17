/**
 * Checks Git/GitHub CLI, remote identity, and local write readiness and classifies diagnostic
 * results.
 */

import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "./values.js";

export interface RepoIdentity {
  owner: string;
  repo: string;
  provider: "github" | "other";
  remoteUrl: string;
}

export interface DiagnosticResult {
  path: string;
  status: "PASS" | "FAIL" | "PARTIAL";
  evidence: string;
  blocker: string | null;
  recommendedUse: boolean;
}

interface DiagnosticsReport {
  repo: RepoIdentity | null;
  defaultBranch: string | null;
  ghCliUser: string | null;
  connectorUser: string | null;
  paths: {
    ghCli: DiagnosticResult;
    localGit: DiagnosticResult;
    localGitWrite: DiagnosticResult;
    connector: DiagnosticResult;
  };
  recommendedFlow:
    | "Local Git + GH CLI"
    | "Local Git + connector PR creation"
    | "Connector-only"
    | "Cannot publish yet";
}

/**
 * Recognizes GitHub HTTPS/SSH remotes; other URLs retain an explicit other-provider identity.
 */
export function parseRepoIdentity(remoteUrl: string | undefined | null): RepoIdentity | null {
  if (!remoteUrl) return null;

  const url = remoteUrl.trim();

  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i,
  );
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      provider: "github",
      remoteUrl: url,
    };
  }

  // SSH: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const sshMatch = url.match(/^(?:ssh:\/\/)?git@github\.com[:\/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      provider: "github",
      remoteUrl: url,
    };
  }

  return {
    owner: "",
    repo: "",
    provider: "other",
    remoteUrl: url,
  };
}

/** Reads origin from the current repository; unavailable Git/remotes return null. */
export function getLocalGitRemoteUrl(): string | null {
  try {
    return execSync("git remote get-url origin", {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Checks local gh installation/authentication without creating a remote resource. */
export function checkGhCli(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "GH CLI",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  try {
    const version = execSync("gh --version", {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n")[0];
    result.evidence = version ?? "Unknown version";
  } catch {
    result.blocker = "gh CLI not installed or not in PATH";
    return result;
  }

  try {
    // gh auth status output format is not structured JSON; pattern-match on known strings.
    const authStatus = execSync("gh auth status", {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    result.evidence += " | Authenticated";
    if (authStatus.includes("Token scopes")) {
      const scopes = authStatus.match(/Token scopes: (.*)/)?.[1];
      if (scopes && !scopes.includes("repo")) {
        result.status = "PARTIAL";
        result.blocker = "Token missing 'repo' scope";
      } else {
        result.status = "PASS";
      }
    } else {
      result.status = "PASS";
    }
  } catch {
    result.blocker = "Not logged in to GitHub CLI";
  }

  return result;
}

/** Checks origin reachability with git ls-remote; does not push or modify refs. */
export function checkLocalGitRemote(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "Local git remote",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  try {
    const remote = execSync("git remote -v", {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n")[0];
    result.evidence = remote ?? "No remote found";

    execSync("git ls-remote origin HEAD", {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    result.status = "PASS";
  } catch {
    result.blocker = "Cannot reach origin remote (check connectivity or remote URL)";
  }

  return result;
}

/**
 * Checks Git-directory writability and index-lock presence; does not prove remote/ref write
 * permission.
 */
export function checkLocalGitWrite(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "Local .git write",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (existsSync(join(gitDir, "index.lock"))) {
      result.blocker = "Git index.lock exists (git process might be running)";
      return result;
    }
    accessSync(resolve(gitDir), constants.W_OK);
    result.status = "PARTIAL";
    result.evidence = "Git directory is writable; ref and remote write capability were not tested.";
  } catch (error) {
    result.blocker = "Git directory is unavailable or not writable.";
    result.evidence = errorMessage(error);
  }

  return result;
}

/** Selects a publish workflow from supplied diagnostic evidence without executing it. */
export function classifyDiagnostics(
  repo: RepoIdentity | null,
  ghCli: DiagnosticResult,
  localGit: DiagnosticResult,
  localGitWrite: DiagnosticResult,
  connector: DiagnosticResult,
): DiagnosticsReport["recommendedFlow"] {
  const isGitHub = repo?.provider === "github";
  if (!isGitHub) return "Cannot publish yet";

  const ghCliOk = ghCli.status === "PASS";
  const gitRemoteOk = localGit.status === "PASS";
  const gitWriteOk =
    localGitWrite.status === "PASS" ||
    (localGitWrite.status === "PARTIAL" && localGitWrite.blocker === null);
  const connectorOk =
    connector.status === "PASS" ||
    (connector.status === "PARTIAL" && !connector.blocker?.includes("auth"));

  if (ghCliOk && gitRemoteOk && gitWriteOk) {
    return "Local Git + GH CLI";
  }

  if (connectorOk) {
    if (gitWriteOk && gitRemoteOk) {
      return "Local Git + connector PR creation";
    }
    return "Connector-only";
  }

  return "Cannot publish yet";
}
