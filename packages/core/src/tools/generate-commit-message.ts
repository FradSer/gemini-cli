/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  BaseTool, 
  ToolResult, 
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome 
} from './tools.js';
import { Config, ApprovalMode } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import { spawn } from 'child_process';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';

const COMMIT_ANALYSIS_PROMPT = `Generate a conventional commit message. Output ONLY the commit message text without any formatting, code blocks, or extra text.

Format: <type>[scope]: <description>

Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Rules:
- Lowercase type and description
- Present tense, no period
- Breaking changes: use ! after type/scope OR "BREAKING CHANGE:" in footer
- Body: explain motivation (optional)
- Footer: "BREAKING CHANGE:", "Closes #123", "Refs #456" (optional)

Examples:
feat(auth): add user login validation

Improve security by validating user credentials.

Closes #456

---
feat(api)!: remove deprecated endpoints

BREAKING CHANGE: The /v1/users endpoint has been removed. Use /v2/users instead.

Instructions:
1. Analyze changes in <commit_analysis> tags
2. Output ONLY the raw commit message text

## Git Status
\`\`\`
{{status}}
\`\`\`

## Git Diff
\`\`\`diff
{{diff}}
\`\`\`

## Recent Commit Messages (for reference)
\`\`\`
{{log}}
\`\`\``;

const COMMIT_CACHE_TIMEOUT_MS = 30000;

/** Format git error messages with user-friendly descriptions */
function formatGitError(
  args: string[],
  exitCode: number,
  stderr: string,
): string {
  const command = args.join(' ');
  const baseError = `Git command failed (${command}) with exit code ${exitCode}`;

  if (!stderr.trim()) {
    return `${baseError}: No error details available`;
  }

  if (stderr.includes('not a git repository')) {
    return (
      'This directory is not a Git repository. ' +
      'Please run this command from within a Git repository.'
    );
  } else if (stderr.includes('no changes added to commit')) {
    return 'No changes have been staged for commit. Use "git add" to stage changes first.';
  } else if (stderr.includes('nothing to commit')) {
    return 'No changes detected. There is nothing to commit.';
  } else if (stderr.includes('index.lock')) {
    return 'Git index is locked. Another git process may be running. Please wait and try again.';
  } else if (stderr.includes('refusing to merge unrelated histories')) {
    return (
      'Cannot merge unrelated Git histories. ' +
      'This may require manual intervention.'
    );
  } else if (
    stderr.includes('pathspec') &&
    stderr.includes('did not match any files')
  ) {
    return (
      'No files match the specified path. ' +
      'Please check the file paths and try again.'
    );
  } else if (
    stderr.includes('fatal: could not read') ||
    stderr.includes('fatal: unable to read')
  ) {
    return 'Unable to read Git repository data. The repository may be corrupted.';
  } else {
    return `${baseError}: ${stderr.trim()}`;
  }
}

/** Execute git command with proper error handling and stdin support */
async function executeGitCommand(
  args: string[],
  signal: AbortSignal,
  stdin?: string,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const commandString = `git ${args.join(' ')}`;

    try {
      const child = spawn('git', args, { signal, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      if (stdin && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }

      child.on('close', (exitCode) => {
        if (exitCode !== 0) {
          const errorMessage = formatGitError(args, exitCode ?? -1, stderr);
          console.error(
            `Command failed: ${commandString}, Error: ${errorMessage}`,
          );
          reject(new Error(errorMessage));
        } else {
          resolve(stdout.trim() || null);
        }
      });

      child.on('error', (err) => {
        const errorMessage = `Failed to execute git command '${commandString}': ${err.message}`;
        console.error(`Spawn error: ${errorMessage}`);

        if (err.message.includes('ENOENT')) {
          reject(
            new Error(
              `Git is not installed or not found in PATH. Please install Git and try again.`,
            ),
          );
        } else if (err.message.includes('EACCES')) {
          reject(
            new Error(
              `Permission denied when executing git command. Please check file permissions.`,
            ),
          );
        } else {
          reject(new Error(errorMessage));
        }
      });
    } catch (error) {
      const errorMessage = `Failed to spawn git process: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`Spawn setup error: ${errorMessage}`);
      reject(new Error(errorMessage));
    }
  });
}

/**
 * Tool for analyzing git changes and generating conventional commit messages.
 * Handles the complete commit workflow: analysis, message generation, and commit creation.
 */
export class GenerateCommitMessageTool extends BaseTool<undefined, ToolResult> {
  static readonly Name = 'generate_commit_message';
  private readonly client: GeminiClient;
  private readonly config: Config;
  
  /** Cache to avoid regenerating commit messages between confirmation and execution */
  private cachedCommitData: {
    statusOutput: string;
    diffOutput: string;
    logOutput: string;
    commitMessage: string;
    timestamp: number;
  } | null = null;
  
  /** Lock to prevent concurrent cache operations */
  private commitLock = false;

  /** Gather git status, staged diff, and recent log in parallel */
  private async analyzeGitState(signal: AbortSignal): Promise<{
    statusOutput: string;
    diffOutput: string;
    logOutput: string;
  }> {
    const [statusOutput, stagedDiff, logOutput] = await Promise.all([
      executeGitCommand(['status', '--porcelain'], signal),
      executeGitCommand(['diff', '--cached'], signal),
      executeGitCommand(['log', '--oneline', '-10'], signal)
    ]);

    return {
      statusOutput: statusOutput || '',
      diffOutput: stagedDiff || '',
      logOutput: logOutput || '',
    };
  }

  constructor(config: Config) {
    super(
      GenerateCommitMessageTool.Name,
      'Generate Commit Message',
      'Executes a git commit workflow: analyzes changes, generates commit message, and creates commit.',
      {
        properties: {},
        required: [],
        type: 'object',
      },
    );
    this.client = config.getGeminiClient();
    this.config = config;
  }

  validateToolParams(_params: undefined): string | null {
    return null;
  }

  getDescription(_params: undefined): string {
    return 'Analyze git changes and create commit.';
  }

  /** Check if confirmation is needed and prepare confirmation details */
  async shouldConfirmExecute(
    _params: undefined,
    signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return false;
    }

    try {
      const gitState = await this.analyzeGitState(signal);

      if (!gitState.diffOutput.trim()) {
        return false;
      }

      const commitMessage = await this.generateCommitMessage(
        gitState.statusOutput,
        gitState.diffOutput,
        gitState.logOutput,
        signal
      );

      const finalCommitMessage = commitMessage;
      
      this.cachedCommitData = {
        statusOutput: gitState.statusOutput,
        diffOutput: gitState.diffOutput,
        logOutput: gitState.logOutput,
        commitMessage,
        timestamp: Date.now(),
      };

      const filesToCommit = this.parseFilesToBeCommitted(
        gitState.statusOutput
      );
      
      let filesDisplay = '';
      if (filesToCommit.length > 0) {
        filesDisplay = `\n\nFiles to be committed:\n` +
          `${filesToCommit.map(f => `  ${f}`).join('\n')}`;
      }

      const commitModeText = 'staged changes only';

      const confirmationDetails: ToolExecuteConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Git Commit',
        command: `git commit -m "${finalCommitMessage.replace(/"/g, '\\"')}"`,
        rootCommand: 'git commit',
        onConfirm: async (outcome: ToolConfirmationOutcome) => {
          if (outcome === ToolConfirmationOutcome.ProceedAlways) {
            this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
          }
        },
      };
      return confirmationDetails;
    } catch (error) {
      console.error('Error determining commit confirmation details:', error);
      return false;
    }
  }

  /** Execute the commit workflow using cached data when available */
  async execute(_params: undefined, signal: AbortSignal): Promise<ToolResult> {
    if (this.commitLock) {
      throw new Error('Another commit operation is in progress');
    }
    
    this.commitLock = true;
    try {
      return await this.executeCommitWorkflow(signal);
    } catch (error) {
      console.error('Error during execution:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error during commit workflow: ${errorMessage}`,
        returnDisplay: `Error during commit workflow: ${errorMessage}`,
      };
    } finally {
      this.commitLock = false;
    }
  }
  
  /** Internal commit workflow implementation */
  private async executeCommitWorkflow(signal: AbortSignal): Promise<ToolResult> {
    const gitState = await this.analyzeGitState(signal);

    if (!gitState.diffOutput.trim()) {
      return {
        llmContent: 'No changes detected in the current workspace.',
        returnDisplay: 'No changes detected in the current workspace.',
      };
    }

    const finalCommitMessage = await this.getOrGenerateCommitMessage(gitState, signal);
    
    try {
      return await this.commitWithRetry(finalCommitMessage, signal);
    } catch (error) {
      this.clearCacheOnCommitError(error);
      throw error;
    }
  }
  
  /** Get cached commit message or abort if git state changed */
  private async getOrGenerateCommitMessage(
    gitState: { statusOutput: string; diffOutput: string; logOutput: string },
    signal: AbortSignal
  ): Promise<string> {
    if (this.cachedCommitData) {
      // If cache is present, validate it.
      const isCacheStale =
        Date.now() - this.cachedCommitData.timestamp >= COMMIT_CACHE_TIMEOUT_MS;
      const hasStateChanged =
        this.cachedCommitData.diffOutput !== gitState.diffOutput ||
        this.cachedCommitData.statusOutput !== gitState.statusOutput ||
        this.cachedCommitData.logOutput !== gitState.logOutput;

      if (isCacheStale) {
        this.cachedCommitData = null; // Invalidate stale cache and proceed to generate new message
      } else if (hasStateChanged) {
        // SECURITY: Git state changed since confirmation. Abort with detailed error.
        const cachedData = this.cachedCommitData;
        this.cachedCommitData = null; // Clear cache
        
        const changes = [];
        if (gitState.diffOutput !== cachedData.diffOutput) {
          changes.push('staged changes');
        }
        if (gitState.statusOutput !== cachedData.statusOutput) {
          changes.push('file status');
        }
        if (gitState.logOutput !== cachedData.logOutput) {
          changes.push('commit history');
        }
        
        throw new Error(
          `Security: Git state changed since confirmation (${changes.join(', ')} modified). ` +
          `Operation aborted to prevent committing unintended changes. ` +
          `Please run the command again to review and confirm the current state.`
        );
      } else {
        // Cache is valid and state is unchanged.
        return this.cachedCommitData.commitMessage;
      }
    }

    // Only generate new commit message if no valid cached data exists.
    const commitMessage = await this.generateCommitMessage(
      gitState.statusOutput,
      gitState.diffOutput,
      gitState.logOutput,
      signal,
    );

    if (!commitMessage?.trim()) {
      throw new Error('Generated commit message is empty');
    }

    this.cachedCommitData = {
      statusOutput: gitState.statusOutput,
      diffOutput: gitState.diffOutput,
      logOutput: gitState.logOutput,
      commitMessage,
      timestamp: Date.now(),
    };

    return commitMessage;
  }
  
  /** Clear cache only for specific error types */
  private clearCacheOnCommitError(error: unknown): void {
    if (error instanceof Error) {
      // Only clear cache for state-related errors, not transient ones
      if (error.message.includes('Git state changed') || 
          error.message.includes('Operation aborted for security') ||
          error.message.includes('not a git repository') ||
          error.message.includes('nothing to commit')) {
        this.cachedCommitData = null;
      }
    }
  }

  /**
   * Attempts to create a git commit with a generated message, including a retry
   * mechanism to handle index lock files. Pre-commit hook failures are not retried.
   */
  private async commitWithRetry(
    commitMessage: string,
    signal: AbortSignal
  ): Promise<ToolResult> {
    // The git state has already been validated by `getOrGenerateCommitMessage`
    // before this function is called, so we can proceed directly to commit.

    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await executeGitCommand(
          ['commit', '-F', '-'],
          signal,
          commitMessage
        );

        this.cachedCommitData = null;

        return {
          llmContent: `Commit created successfully!\n\nCommit message:\n${commitMessage}`,
          returnDisplay: `Commit created successfully!\n\nCommit message:\n${commitMessage}`,
        };
      } catch (commitError) {
        if (!(commitError instanceof Error)) {
          throw commitError;
        }

        if (/\.git\/hooks\//.test(commitError.message)) {
          const hookError = new Error(
            `Commit failed due to a pre-commit hook. ` +
              `Please resolve the issues, stage any changes, and try again. ` +
              `Original error: ${commitError.message}`
          );
          throw hookError;
        }

        const isIndexLockError = commitError.message.includes('index.lock');

        if (!isIndexLockError || attempt === maxRetries) {
          throw commitError;
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw new Error('Commit failed after all retry attempts.');
  }

  /** Parse git status output to extract files that will be committed */
  private parseFilesToBeCommitted(statusOutput: string): string[] {
    const lines = statusOutput.split('\n').filter(line => line.trim());
    const files: string[] = [];

    for (const line of lines) {
      if (line.length < 3) continue;
      
      const status = line.substring(0, 2);
      const filename = line.substring(3).trim();
      
      // Skip unimportant directories
      if (filename.includes('node_modules/') || filename.includes('.git/')) continue;
      
      // Include files with staged changes (first character not space or ?)
      if (status[0] !== ' ' && status[0] !== '?') {
        files.push(filename);
      }
    }

    return files;
  }

  /** Generate commit message using Gemini AI with conventional commits format */
  private async generateCommitMessage(
    status: string,
    diff: string,
    log: string,
    signal: AbortSignal,
  ): Promise<string> {
    const prompt = COMMIT_ANALYSIS_PROMPT
      .replace('{{status}}', status)
      .replace('{{diff}}', diff)
      .replace('{{log}}', log);


    try {
      const response = await this.client.generateContent(
        [{ role: 'user', parts: [{ text: prompt }] }],
        {},
        signal,
      );

      const generatedText = getResponseText(response) ?? '';
      
      // Extract commit message from analysis response
      const analysisEndIndex = generatedText.indexOf('</commit_analysis>');
      if (analysisEndIndex !== -1) {
        const commitMessage = generatedText
          .substring(analysisEndIndex + '</commit_analysis>'.length)
          .trim()
          .replace(/^```[a-z]*\n?/, '') // Remove code block markers
          .replace(/```$/, '')
          .trim();
        
        return commitMessage;
      }

      return generatedText;
    } catch (error) {
      console.error('Error during Gemini API call:', error);
      throw new Error(`Failed to generate commit message: ` +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
