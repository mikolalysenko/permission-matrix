/** Basic non-secret environment shared by CLI preflight and attempts. */
export function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
  };
}
