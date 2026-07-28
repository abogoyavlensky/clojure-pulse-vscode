import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReplProcess, parseNreplPort } from "../repl/replProcess";

/** The spawn tests drive real POSIX shell commands; skip them on Windows. */
const POSIX = process.platform !== "win32";

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

suite("parseNreplPort", () => {
  test("reads the port from nREPL's startup line", () => {
    assert.strictEqual(
      parseNreplPort("nREPL server started on port 55123 on host localhost"),
      55123,
    );
  });

  test("ignores unrelated output", () => {
    assert.strictEqual(parseNreplPort("Downloading: nrepl/nrepl/1.7.0\n"), undefined);
    assert.strictEqual(parseNreplPort("port 55123"), undefined);
  });

  test("finds the line anywhere in accumulated output", () => {
    const text = "Downloading deps…\nnREPL server started on port 7777\nready\n";
    assert.strictEqual(parseNreplPort(text), 7777);
  });

  test("first match wins", () => {
    const text =
      "nREPL server started on port 100\nnREPL server started on port 200\n";
    assert.strictEqual(parseNreplPort(text), 100);
  });

  test("rejects an out-of-range port", () => {
    assert.strictEqual(
      parseNreplPort("nREPL server started on port 99999"),
      undefined,
    );
  });
});

suite("ReplProcess", () => {
  let dir: string;
  let running: ReplProcess[] = [];

  const spawn = (command: string, options: { portFilePollMs?: number } = {}) => {
    const proc = new ReplProcess({ command, cwd: dir, ...options });
    running.push(proc);
    return proc;
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-process-test-"));
  });

  teardown(async () => {
    // Stop everything a test started, so a failed assertion cannot leak a
    // long-running `sleep` into the rest of the run.
    await Promise.all(running.map((proc) => proc.stop()));
    running = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves the port from the startup line", async function () {
    if (!POSIX) {
      this.skip();
    }
    const proc = spawn('echo "nREPL server started on port 12345" && sleep 30');
    proc.start();
    assert.strictEqual(await proc.waitForPort(), 12345);
  });

  test("streams stdout and stderr to output listeners", async function () {
    if (!POSIX) {
      this.skip();
    }
    const chunks: string[] = [];
    const proc = spawn("echo out-line && echo err-line 1>&2");
    proc.onOutput((text) => chunks.push(text));
    proc.start();

    await waitUntil(() => chunks.join("").includes("err-line"), 5000);
    const text = chunks.join("");
    assert.ok(text.includes("out-line"), text);
    assert.ok(text.includes("err-line"), text);
  });

  test("rejects waitForPort when the process exits without a port", async function () {
    if (!POSIX) {
      this.skip();
    }
    const proc = spawn("echo nope && exit 3");
    proc.start();
    await assert.rejects(proc.waitForPort(), /exited with code 3/);
  });

  test("reports exit to onExit listeners", async function () {
    if (!POSIX) {
      this.skip();
    }
    const exits: { code: number | null }[] = [];
    const proc = spawn("exit 0");
    proc.onExit((info) => exits.push(info));
    proc.start();

    await waitUntil(() => exits.length > 0, 5000);
    assert.strictEqual(exits[0].code, 0);
  });

  test("stop() kills the process group and fires onExit", async function () {
    if (!POSIX) {
      this.skip();
    }
    let exited = false;
    const proc = spawn("sleep 30");
    proc.onExit(() => {
      exited = true;
    });
    proc.start();
    const pid = proc.pid;
    assert.ok(pid, "expected a pid after start()");

    await proc.stop();

    assert.strictEqual(exited, true, "expected onExit to fire");
    await waitUntil(() => !groupAlive(pid), 2000);
    assert.strictEqual(groupAlive(pid), false, "process group should be gone");
  });

  test("stop() before start() is a no-op", async function () {
    const proc = spawn("sleep 30");
    await proc.stop();
    assert.strictEqual(proc.pid, undefined);
  });

  test("falls back to the .nrepl-port file written after start", async function () {
    if (!POSIX) {
      this.skip();
    }
    const proc = spawn("sleep 0.2 && echo 7999 > .nrepl-port && sleep 30", {
      portFilePollMs: 50,
    });
    proc.start();
    assert.strictEqual(await proc.waitForPort(), 7999);
  });

  test("ignores a stale .nrepl-port file from a previous run", async function () {
    if (!POSIX) {
      this.skip();
    }
    const stale = path.join(dir, ".nrepl-port");
    fs.writeFileSync(stale, "6000\n");
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(stale, hourAgo, hourAgo);

    const proc = spawn("sleep 0.2 && exit 1", { portFilePollMs: 50 });
    proc.start();
    await assert.rejects(proc.waitForPort(), /exited with code 1/);
  });

  test("waitForPort returns the same promise for repeat callers", async function () {
    if (!POSIX) {
      this.skip();
    }
    const proc = spawn('echo "nREPL server started on port 12345" && sleep 30');
    proc.start();
    assert.strictEqual(proc.waitForPort(), proc.waitForPort());
    assert.strictEqual(await proc.waitForPort(), 12345);
  });
});

/** True while any process in the group led by `pid` is still alive. */
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
