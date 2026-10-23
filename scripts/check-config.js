import { configFromEnv } from "../lib/common.js";
try {
  configFromEnv();
  console.log("Configuration valid. Secret values were not printed. API access has not been tested.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
