/**
 * Mocha setup: alias the `vscode` module to our lightweight mock so that
 * modules importing `vscode` can run in plain Node during unit tests.
 */
import * as path from "path";
import Module from "module";

const mockPath = path.join(__dirname, "mocks", "vscode.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalResolve = (Module as any)._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._resolveFilename = function (
  request: string,
  ...args: unknown[]
): string {
  if (request === "vscode") {
    return mockPath;
  }
  return originalResolve.call(this, request, ...args);
};
