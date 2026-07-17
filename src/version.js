import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const VERSION = String(packageJson.version);
export const PRODUCT_NAME = "WeClaudex";
export const USER_AGENT = `${PRODUCT_NAME}/${VERSION}`;
