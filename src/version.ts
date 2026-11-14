import pkg from "../package.json" with { type: "json" };

// The identifier `bun build --define` injects. Release binaries name the same version as
// the tag; a development run (no definition) names package.json's version. It is not
// process.env because a user's env could fake the version.
declare const __BUILD_VERSION__: string | undefined;

export const VERSION: string =
  typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : pkg.version;
