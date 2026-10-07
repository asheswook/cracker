import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("clipboard helper strips credential environment and rechecks abort before paste", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipboard-boundary-"));
  try {
    await Bun.write(
      join(directory, "xclip"),
      `#!/bin/sh\ncat > '${directory}/clipboard'\nif [ -z "$VM_TOKEN$OPENAI_API_KEY$DATABASE_URL$CHATGPT_TOKEN_FILE" ]; then touch '${directory}/safe'; fi\n`,
    );
    await Bun.write(
      join(directory, "xdotool"),
      `#!/bin/sh\nif [ "$1" = getwindowfocus ]; then echo 42; else touch '${directory}/pasted'; fi\n`,
    );
    await Bun.write(
      join(directory, "xprop"),
      `#!/bin/sh\nprintf 'WM_CLASS(STRING) = "test", "Test"\\n'\n`,
    );
    await chmod(join(directory, "xprop"), 0o700);
    await Bun.write(
      join(directory, "python3"),
      `#!/bin/sh
if [ -f '${directory}/clipboard' ]; then echo 81; else echo 80; fi
`,
    );
    await chmod(join(directory, "python3"), 0o700);
    await chmod(join(directory, "xclip"), 0o700);
    await chmod(join(directory, "xdotool"), 0o700);
    const script = join(directory, "test.ts");
    await Bun.write(
      script,
      `import { pasteUnicode } from ${JSON.stringify(resolve("packages/screen/text.ts"))};
const abort = new AbortController(); let count = 0;
try { await pasteUnicode("한글", ":123", () => { if (++count === 3) abort.abort(); abort.signal.throwIfAborted(); }); process.exitCode = 2; }
catch (error) { if (!(error instanceof Error && error.name === "AbortError")) throw error; }
`,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        PATH: `${directory}:/usr/bin:/bin`,
        VM_TOKEN: "private-fixture",
        OPENAI_API_KEY: "private-fixture",
        DATABASE_URL: "private-fixture",
        CHATGPT_TOKEN_FILE: "private-fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await Bun.file(join(directory, "clipboard")).text()).toBe("한글");
    expect(await Bun.file(join(directory, "safe")).exists()).toBe(true);
    expect(await Bun.file(join(directory, "pasted")).exists()).toBe(false);
    await rm(join(directory, "clipboard"));
    await Bun.write(
      join(directory, "xdotool"),
      `#!/bin/sh
if [ "$1" = getwindowfocus ]; then if [ -f '${directory}/clipboard' ]; then echo 43; else echo 42; fi; else touch '${directory}/pasted'; fi
`,
    );
    await Bun.write(
      script,
      `import { pasteUnicode } from ${JSON.stringify(resolve("packages/screen/text.ts"))};
try { await pasteUnicode("한글", ":123", () => {}); process.exitCode=2; }
catch(error) { if (!(error instanceof Error && "code" in error && error.code === "paste_focus_changed")) throw error; }
`,
    );
    const changed = Bun.spawn([process.execPath, script], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await changed.exited).toBe(0);
    expect(await new Response(changed.stderr).text()).toBe("");
    expect(await Bun.file(join(directory, "pasted")).exists()).toBe(false);
    await rm(join(directory, "clipboard"));
    await Bun.write(
      join(directory, "xdotool"),
      `#!/bin/sh
if [ "$1" = getwindowfocus ]; then echo 42; else touch '${directory}/pasted'; fi
`,
    );
    await Bun.write(
      join(directory, "python3"),
      `#!/bin/sh
if [ ! -f '${directory}/clipboard' ]; then echo 80; elif [ ! -f '${directory}/owner-read' ]; then touch '${directory}/owner-read'; echo 81; else echo 82; fi
`,
    );
    await Bun.write(
      script,
      `import { pasteUnicode } from ${JSON.stringify(resolve("packages/screen/text.ts"))};
try { await pasteUnicode("한글", ":123", () => {}); process.exitCode=2; }
catch(error) { if (!(error instanceof Error && "code" in error && error.code === "clipboard_owner_changed")) throw error; }
`,
    );
    const replaced = Bun.spawn([process.execPath, script], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await replaced.exited).toBe(0);
    expect(await new Response(replaced.stderr).text()).toBe("");
    expect(await Bun.file(join(directory, "pasted")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clipboard writer timeout fails before paste and terminates the hung writer", async () => {
  // Given an isolated command path with a writer that never completes.
  const directory = await mkdtemp(join(tmpdir(), "clipboard-timeout-"));
  try {
    const scripts = {
      xclip: `#!/bin/sh\necho $$ > '${directory}/pid'\nexec sleep 30\n`,
      xdotool: `#!/bin/sh\nif [ "$1" = getwindowfocus ]; then echo 42; else touch '${directory}/pasted'; fi\n`,
      xprop: '#!/bin/sh\nprintf \'WM_CLASS(STRING) = "test", "Test"\\n\'\n',
      python3: '#!/bin/sh\necho 80\n',
    };
    for (const [name, source] of Object.entries(scripts)) {
      await Bun.write(join(directory, name), source);
      await chmod(join(directory, name), 0o700);
    }
    const script = join(directory, "run.ts");
    await Bun.write(script, `import { pasteUnicode } from ${JSON.stringify(resolve("packages/screen/text.ts"))};
try { await pasteUnicode("한글", ":123", () => {}); process.exitCode=2; }
catch(error) { if (!(error instanceof Error && "code" in error && error.code === "clipboard_timeout")) throw error; }
`);
    // When the clipboard writer exceeds its existing bounded deadline.
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    // Then no paste was issued and the owned writer has been killed.
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await Bun.file(join(directory, "pasted")).exists()).toBe(false);
    const pid = Number((await Bun.file(join(directory, "pid")).text()).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 10000);
