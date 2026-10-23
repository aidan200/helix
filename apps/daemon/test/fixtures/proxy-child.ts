import { installChildProxyFetch } from "../../src/adapters/driven/subagent/child/proxy-config";
const undo = installChildProxyFetch(process.argv[2]);
try {
  const results: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch("http://helix-proxy-test.invalid/probe", { signal: AbortSignal.timeout(3000) });
    results.push(await response.text());
  }
  console.log(JSON.stringify(results));
} finally { undo(); }
