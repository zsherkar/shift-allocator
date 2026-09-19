import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

// Resolve through the consumers so these checks exercise the versions the app uses.
const apiRequire = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const expressRequire = createRequire(apiRequire.resolve("express"));
const qs = expressRequire("qs");
const clientRequire = createRequire(
  new URL("../artifacts/shift-scheduler/package.json", import.meta.url),
);
const excelRequire = createRequire(clientRequire.resolve("exceljs"));
const uuid = excelRequire("uuid");
const ExcelJS = clientRequire("exceljs");
const specRequire = createRequire(
  new URL("../lib/api-spec/package.json", import.meta.url),
);
const zodRequire = createRequire(
  new URL("../lib/api-zod/package.json", import.meta.url),
);
const runFile = promisify(execFile);

async function generatorFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "ish-security-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ish-security-"));
    await rm(directory, { recursive: true, force: true });
  });
  const inputDirectory = path.join(directory, "input");
  await mkdir(inputDirectory);
  const input = path.join(inputDirectory, "openapi.json");
  const output = path.join(directory, "api.ts");
  const config = path.join(directory, "orval.config.cjs");
  await writeFile(
    config,
    `module.exports = ${JSON.stringify({
      probe: {
        input,
        output: {
          target: output,
          client: "zod",
          override: { zod: { version: 3 } },
        },
      },
    })};`,
  );
  return {
    directory,
    input,
    output,
    run: () =>
      runFile(
        process.execPath,
        [specRequire.resolve("orval/bin/orval"), "--config", config],
        {
          cwd: directory,
          timeout: 30_000,
        },
      ),
  };
}

function probeSpec(parameters = [], responseSchema = { type: "string" }) {
  return {
    openapi: "3.0.3",
    info: { title: "Probe", version: "1" },
    paths: {
      "/probe": {
        get: {
          operationId: "probe",
          parameters,
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: responseSchema } },
            },
          },
        },
      },
    },
  };
}

test("Orval treats template-expression defaults and computed-property names as data", async (t) => {
  const fixture = await generatorFixture(t);
  const payload = "${globalThis.__orvalInjected = true}";
  const propertyName = 'x"]:(globalThis.__orvalInjected=true),["y';
  await writeFile(
    fixture.input,
    JSON.stringify(
      probeSpec([
        {
          in: "query",
          name: "value",
          schema: { type: "string", default: payload },
        },
        { in: "query", name: propertyName, schema: { type: "string" } },
      ]),
    ),
  );
  await fixture.run();
  const generated = await readFile(fixture.output, "utf8");
  const { code } = await apiRequire("esbuild").transform(generated, {
    loader: "ts",
    format: "cjs",
  });
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.equal(name, "zod");
      return zodRequire("zod");
    },
  };
  vm.runInNewContext(code, context, { timeout: 1_000 });
  assert.equal(context.__orvalInjected, undefined);
  const schema = context.module.exports.ProbeQueryParams;
  assert.ok(schema, "expected the generated query validator export");
  const parsed = schema.parse({ [propertyName]: "ordinary text" });
  assert.equal(parsed.value, payload);
  assert.equal(parsed[propertyName], "ordinary text");
});

test("Orval blocks remote and out-of-tree references by default", async (t) => {
  for (const reference of [
    "https://example.invalid/schema.json",
    "../private.json",
  ]) {
    const fixture = await generatorFixture(t);
    await writeFile(
      path.join(fixture.directory, "private.json"),
      JSON.stringify({ type: "string" }),
    );
    await writeFile(
      fixture.input,
      JSON.stringify(probeSpec([], { $ref: reference })),
    );
    await assert.rejects(fixture.run, (error) => {
      assert.match(
        `${error.stdout}\n${error.stderr}`,
        /external.*ref|outside.*allowed|not allowed|not permitted|disabled|blocked/i,
      );
      return true;
    });
    await assert.rejects(readFile(fixture.output), { code: "ENOENT" });
  }
});

test("query-string round trips tolerate attacker-controlled constructor properties", () => {
  for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
    const parsed = qs.parse("x%5Bconstructor%5D%5BisBuffer%5D=y", options);
    assert.doesNotThrow(() => qs.stringify(parsed));
  }
  assert.equal(
    qs.stringify(qs.parse("name=Asha&shift=2")),
    "name=Asha&shift=2",
  );
});

test("comma-formatted query strings tolerate null array entries", () => {
  assert.equal(
    qs.stringify(
      { a: [null, "b"] },
      { arrayFormat: "comma", encodeValuesOnly: true },
    ),
    "a=,b",
  );
});

test("UUID v5 rejects incomplete output buffers and preserves valid identifiers", () => {
  const namespace = uuid.v5.DNS;
  for (const [buffer, offset] of [
    [new Uint8Array(8), 4],
    [new Uint8Array(16), -1],
  ]) {
    assert.throws(
      () => uuid.v5("example.com", namespace, buffer, offset),
      RangeError,
    );
  }
  assert.equal(
    uuid.v5("example.com", namespace),
    "cfbff0d1-9375-5685-968c-48ce8b15ae17",
  );
  assert.equal(uuid.validate(uuid.v4()), true);
});

test("ExcelJS serializes and reloads a workbook through its UUID v4 caller", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Schedule");
  sheet.addRow(["Name", "Hours"]);
  sheet.addRow(["Asha", 6]);
  // Extended conditional formatting invokes ExcelJS's require('uuid').v4().
  sheet.addConditionalFormatting({
    ref: "B2",
    rules: [
      {
        type: "dataBar",
        minLength: 0,
        maxLength: 100,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: { argb: "FF336699" },
      },
    ],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(bytes);
  assert.equal(reloaded.getWorksheet("Schedule").getCell("A2").value, "Asha");
  assert.equal(reloaded.getWorksheet("Schedule").getCell("B2").value, 6);
  assert.equal(
    reloaded.getWorksheet("Schedule").conditionalFormattings.length,
    1,
  );
});
