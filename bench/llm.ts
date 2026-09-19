// The bench asks its LLM questions through pi print mode, so it uses the model and login that pi already has.
import { execFile } from "node:child_process";

export function askPi(prompt: string): Promise<{ text: string; ms: number }> {
	const started = performance.now();
	const args = ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", prompt];
	return new Promise((resolve, reject) => {
		const child = execFile("pi", args, { maxBuffer: 10 * 1024 * 1024, timeout: 180_000 }, (error, stdout) => {
			if (error) reject(error);
			else resolve({ text: stdout.trim(), ms: performance.now() - started });
		});
		// pi reads piped stdin until it closes.
		child.stdin?.end();
	});
}
