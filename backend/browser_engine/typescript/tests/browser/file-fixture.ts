import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/** The statement the fixture's download link serves. */
export const statement = "date,amount\n2026-01-02,12.50\n2026-01-03,8.00\n";
export const statementSha256 = createHash("sha256").update(statement).digest("hex");

/**
 * A site with a file input that uploads the chosen file and shows what the server received (its
 * name, size and sha256), and a link that downloads a statement. `received` lists each upload.
 * Its `/drop` page uploads a file the moment its input holds one; with `frame`, the main page
 * embeds that address in an iframe.
 */
export const startFileSite = async (options: { readonly frame?: string } = {}) => {
  const received: { readonly name: string; readonly size: number; readonly sha256: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (request.method === "POST" && url.pathname === "/upload") {
        const body = Buffer.concat(chunks);
        const upload = {
          name: url.searchParams.get("name") ?? "",
          size: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
        received.push(upload);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(upload));
        return;
      }
      if (url.pathname === "/statement.csv") {
        response.setHeader("Content-Type", "text/csv");
        response.setHeader("Content-Disposition", 'attachment; filename="statement.csv"');
        response.end(statement);
        return;
      }
      response.setHeader("Content-Type", "text/html");
      if (url.pathname === "/drop") {
        response.end(`<title>Drop</title>
<label>Drop <input type="file"></label>
<script>
document.querySelector("input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  fetch("/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
});
</script>`);
        return;
      }
      response.end(`<title>Documents</title>
<label>Receipt <input type="file" accept=".pdf,.txt,text/plain"></label>
<button type="button" id="upload">Upload</button>
<output id="received"></output>
<label>Notes <input type="text"></label>
<a href="/statement.csv">Download statement</a>
${options.frame === undefined ? "" : `<iframe src="${options.frame}"></iframe>`}
<script>
document.getElementById("upload").addEventListener("click", async () => {
  const file = document.querySelector("input[type=file]").files[0];
  const answer = await fetch("/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
  const upload = await answer.json();
  document.getElementById("received").textContent = upload.name + " " + upload.size + " " + upload.sha256;
});
</script>`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

/**
 * A write tool that downloads the statement, then uploads its receipt and reads back what the site
 * received, returning both. `field` names the input it places the receipt into.
 */
export const receiptTool = (field: unknown = { label: "Receipt" }) => `import { Schema } from "effect";
import { defineOperation, FileInput, FileOutput } from "../runtime/index.js";
export default defineOperation({name:"send_receipt",input:Schema.Struct({receipt:FileInput}),output:Schema.Struct({received:Schema.String,statement:FileOutput}),write:{confirmation:"readback",commits:["upload"]}},
async ({kernel,sessionId,input,files,enteringCommit,verified,errors}) => {
  const statement = await files.collect(() => kernel.browsers.playwright.execute(sessionId,{code:"await page.getByRole('link', { name: 'Download statement' }).click(); return true;",timeout_sec:10}));
  const placed = await files.place(input.receipt, { field: ${JSON.stringify(field)} });
  enteringCommit("upload");
  const sent = await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#upload').click(); await page.waitForFunction(() => document.getElementById('received').textContent !== '', null, { timeout: 5000 }); return await page.locator('#received').textContent();",timeout_sec:10});
  if(!sent.success) throw new errors.OperationFailure(String(sent.error), { stderr: sent.stderr });
  if(!String(sent.result).startsWith(placed.name + " " + placed.size + " ")) throw new errors.OperationFailure("The upload did not read back");
  verified();
  return {received:String(sent.result),statement};
});`;
