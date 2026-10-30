/**
 * Add upstream model discovery to the direct DeepSeek settings card.
 *
 * The installed DSH frontend edits the DeepSeek catalog by hand, while its
 * discovery method only repeats the configured catalog. This boot-time patch
 * is idempotent and scoped to the exact files/strings it knows:
 *
 *   1. the API-key adapter asks the provider's /models endpoint;
 *   2. the DeepSeek editor gets a "Fetch available models" action.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "/opt/dsh/node_modules";
const ADAPTER_MARKER_V1 = "DHA_UPSTREAM_MODEL_DISCOVERY_V1";
const ADAPTER_MARKER_V2 = "DHA_UPSTREAM_MODEL_DISCOVERY_V2";
const ADAPTER_MARKER = "DHA_UPSTREAM_MODEL_DISCOVERY_V3";
const UI_MARKER_V1 = "DHA_UPSTREAM_MODEL_DISCOVERY_V1";
const UI_MARKER_V2 = "DHA_UPSTREAM_MODEL_DISCOVERY_V2";
const UI_MARKER_V3 = "DHA_UPSTREAM_MODEL_DISCOVERY_V3";
const UI_MARKER = "DHA_UPSTREAM_MODEL_DISCOVERY_V4";
const MODELS_PKG = "@deepseek-ai/dsh-client-ui-settings-models";
const LOCAL_VISION_SLOT_MARKER = "DHA_LOCAL_VISION_MODELS_SLOT_V2";
const LOCAL_VISION_SLOT_MARKER_V1 = "DHA_LOCAL_VISION_MODELS_SLOT_V1";
const LOCAL_TITLE_MARKER = "DHA_LOCAL_TITLE_NO_AUX_V1";
let changed = 0;
let checked = 0;

/**
 * Remove the local multimodal model controls from an older installed frontend.
 * The provider and native runtime are gone; leaving an empty slot in this
 * package would render a broken card until the runtime is reinstalled.
 */
function removeLocalVisionSlot(source) {
  let next = source;
  for (const marker of [LOCAL_VISION_SLOT_MARKER, LOCAL_VISION_SLOT_MARKER_V1]) {
    const slot = `\n\t\t\t\t\t// ${marker}
\t\t\t\t\t(0, react_jsx_runtime.jsx)("section", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["rowCard"],
\t\t\t\t\t\tchildren: renderSlot("settings.models.local-vision", {}, {
\t\t\t\t\t\t\tentryKey: "local-vision"
\t\t\t\t\t\t})
\t\t\t\t\t}),`;
    if (next.includes(slot)) next = next.replace(slot, "");
  }
  const child = `\t\t\t\t\t"settings.models.local-vision": {
\t\t\t\t\t\tkind: "single",
\t\t\t\t\t\tscope: "root"
\t\t\t\t\t},
`;
  if (next.includes(child)) next = next.replace(child, "");
  return next;
}

function edit(pkg, relative, transform) {
  const path = join(root, pkg, relative);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return;
  }
  checked++;
  let next;
  try {
    next = transform(source);
    if (pkg === MODELS_PKG) next = removeLocalVisionSlot(next);
  } catch (error) {
    console.log(`repair-model-fetch: skipped ${pkg}/${relative}: ${error.message}`);
    return;
  }
  if (next === source) return;
  writeFileSync(path, next, "utf8");
  changed++;
  console.log(`repair-model-fetch: patched ${pkg}/${relative}`);
}

edit("@deepseek-ai/dsh-llm-deepseek-api-key", "lib/index.js", (source) => {
  if (source.includes(ADAPTER_MARKER)) return source;
  if (source.includes(ADAPTER_MARKER_V2)) {
    const oldPush = `\t\t\t\t\t\tmodels.push(catalogModelInfo(provider, {
\t\t\t\t\t\t\tid,
\t\t\t\t\t\t\t...row && typeof row.name === "string" && row.name !== "" ? { name: row.name } : {}
\t\t\t\t\t\t}));`;
    const newPush = `\t\t\t\t\t\tconst info = {
\t\t\t\t\t\t\tprovider,
\t\t\t\t\t\t\tid,
\t\t\t\t\t\t\tname: row && typeof row.name === "string" && row.name !== "" ? row.name : id
\t\t\t\t\t\t};
\t\t\t\t\t\tconst declared = row && Array.isArray(row.inputModalities) ? row.inputModalities
\t\t\t\t\t\t\t: row && Array.isArray(row.input_modalities) ? row.input_modalities : [];
\t\t\t\t\t\tconst modalities = [...new Set(declared.filter((value) => value === "text" || value === "image"))];
\t\t\t\t\t\tif (modalities.length > 0) info.inputModalities = modalities;
\t\t\t\t\t\tmodels.push(info);`;
    if (!source.includes(oldPush)) throw new Error("v2 discovered-model block changed");
    return source.replace(oldPush, newPush)
      .replace(`// ${ADAPTER_MARKER_V2}`, `// ${ADAPTER_MARKER}`);
  }
  let next = source;
  const oldBlock = `\t\tdiscoverModels: (provider) => {
\t\t\tconst connection = options();
\t\t\treturn Promise.resolve(connection.models.map((model) => catalogModelInfo(provider, model)));
\t\t}`;
  const nextBlock = `\t\t// ${ADAPTER_MARKER}
\t\tdiscoverModels: async (provider) => {
\t\t\tconst connection = options();
\t\t\tconst apiKey = await resolveApiKey(connection);
\t\t\tconst root = connection.baseURL.replace(/\\/+$/u, "");
\t\t\tconst origin = new URL(root).origin;
\t\t\tconst endpoints = [...new Set([
\t\t\t\t\`\${root}/models\`,
\t\t\t\t\`\${root}/v1/models\`,
\t\t\t\t\`\${root.replace(/\\/anthropic(?:\\/v1)?$/u, "")}/models\`,
\t\t\t\t\`\${origin}/models\`
\t\t\t])];
\t\t\tlet lastError;
\t\t\tfor (const endpoint of endpoints) {
\t\t\t\ttry {
\t\t\t\t\tconst response = await fetch(endpoint, {
\t\t\t\t\t\tredirect: "error",
\t\t\t\t\t\tsignal: AbortSignal.timeout(15000),
\t\t\t\t\t\theaders: {
\t\t\t\t\t\t\tAuthorization: \`Bearer \${apiKey}\`,
\t\t\t\t\t\t\t"x-api-key": apiKey
\t\t\t\t\t\t}
\t\t\t\t\t});
\t\t\t\t\tif (!response.ok) throw new Error(\`HTTP \${response.status}\`);
\t\t\t\t\tconst body = await response.json();
\t\t\t\t\tconst rows = Array.isArray(body.data) ? body.data
\t\t\t\t\t\t: Array.isArray(body.models) ? body.models : [];
\t\t\t\t\tconst seen = new Set();
\t\t\t\t\tconst models = [];
\t\t\t\t\tfor (const row of rows) {
\t\t\t\t\t\tconst id = typeof row === "string" ? row
\t\t\t\t\t\t\t: row && typeof row.id === "string" ? row.id : "";
\t\t\t\t\t\tif (id === "" || seen.has(id)) continue;
\t\t\t\t\t\tseen.add(id);
\t\t\t\t\t\tconst info = {
\t\t\t\t\t\t\tprovider,
\t\t\t\t\t\t\tid,
\t\t\t\t\t\t\tname: row && typeof row.name === "string" && row.name !== "" ? row.name : id
\t\t\t\t\t\t};
\t\t\t\t\t\tconst declared = row && Array.isArray(row.inputModalities) ? row.inputModalities
\t\t\t\t\t\t\t: row && Array.isArray(row.input_modalities) ? row.input_modalities : [];
\t\t\t\t\t\tconst modalities = [...new Set(declared.filter((value) => value === "text" || value === "image"))];
\t\t\t\t\t\tif (modalities.length > 0) info.inputModalities = modalities;
\t\t\t\t\t\tmodels.push(info);
\t\t\t\t\t}
\t\t\t\t\tif (models.length > 0) return models;
\t\t\t\t\tthrow new Error("provider returned no models");
\t\t\t\t} catch (error) {
\t\t\t\t\tlastError = error;
\t\t\t\t}
\t\t\t}
\t\t\tthrow new LlmError(\`DeepSeek upstream model discovery failed: \${lastError?.message ?? "no endpoint answered"}\`, "TRANSPORT", {
\t\t\t\t...lastError === undefined ? {} : { cause: lastError }
\t\t\t});
\t\t}`;
  if (!next.includes(ADAPTER_MARKER_V1)) {
    if (!next.includes(oldBlock)) throw new Error("DeepSeek discovery block changed");
    next = next.replace(oldBlock, nextBlock);
  } else {
    next = next.replace(`// ${ADAPTER_MARKER_V1}`, `// ${ADAPTER_MARKER}`);
  }
  const anchor = "\t});\n}\n//#endregion";
  const registration = `\t});
\tconst discoverDeepSeek = async () => ctx.llm.listModels(PROVIDER);
\tconst discoveryNs = ctx.fiber.entry?.options.id ?? "llm-deepseek-api-key";
\tctx.llm.registerModelDiscovery(discoveryNs, discoverDeepSeek);
\tif (discoveryNs !== "llm-deepseek") {
\t\tctx.llm.registerModelDiscovery("llm-deepseek", discoverDeepSeek);
\t}
}
//#endregion`;
  if (!next.includes(anchor)) throw new Error("DeepSeek provider registration end changed");
  return next.replace(anchor, registration);
});

edit("@deepseek-ai/dsh-client-ui-settings-models", "lib/client.js", (source) => {
  if (source.includes(UI_MARKER)) return source;
  if (source.includes(UI_MARKER_V3)) {
    if (!source.includes(`"llm-deepseek-api-key" : props.probe.settingsNs`)) {
      throw new Error("v3 discovery namespace call changed");
    }
    return source
      .replace(`"llm-deepseek-api-key" : props.probe.settingsNs`, `"llm-deepseek" : props.probe.settingsNs`)
      .replace(`// ${UI_MARKER_V3}`, `// ${UI_MARKER}`);
  }
  if (source.includes(UI_MARKER_V2)) {
    const v2Props = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\toperations,
\t\t\t\t\tprobe,`;
    const v3Props = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\tprovider: props.provider,
\t\t\t\t\toperations,
\t\t\t\t\tprobe,`;
    if (!source.includes(v2Props)) throw new Error("v2 catalogProps block changed");
    return source
      .replace(v2Props, v3Props)
      .replace(`// ${UI_MARKER_V2}`, `// ${UI_MARKER}`);
  }
  if (source.includes(UI_MARKER_V1)) {
    const oldCall = "props.operations.discoverModels(props.probe.settingsNs,";
    if (!source.includes(oldCall)) throw new Error("v1 discovery call changed");
    const v1Props = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\toperations,
\t\t\t\t\tprobe,`;
    const v3Props = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\tprovider: props.provider,
\t\t\t\t\toperations,
\t\t\t\t\tprobe,`;
    if (!source.includes(v1Props)) throw new Error("v1 catalogProps block changed");
    return source
      .replace(oldCall, `props.operations.discoverModels(props.provider === "deepseek-official" ? "llm-deepseek-api-key" : props.probe.settingsNs,`)
      .replace(v1Props, v3Props)
      .replace(`// ${UI_MARKER_V1}`, `// ${UI_MARKER}`);
  }
  const startToken = "\t\tfunction DeepSeekModelsEditor(props) {";
  const endToken = "\n\t\t}\n\t\t//#endregion\n\t\t//#region lib/types/client/ModelListEditor.js";
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  if (start < 0 || end < 0) throw new Error("DeepSeekModelsEditor block changed");
  let block = source.slice(start, end);

  const stateToken = `\t\t\tconst [expanded, setExpanded] = (0, react.useState)(() => /* @__PURE__ */ new Set());`;
  const fetchCode = `${stateToken}
\t\t\t// ${UI_MARKER}
\t\t\tconst [fetching, setFetching] = (0, react.useState)(false);
\t\t\tconst [fetchMessage, setFetchMessage] = (0, react.useState)("");
\t\t\tconst fetchFromUpstream = async () => {
\t\t\t\tif (props.operations === void 0 || props.probe === void 0) return;
\t\t\t\tsetFetching(true);
\t\t\t\tsetFetchMessage("");
\t\t\t\ttry {
\t\t\t\t\tconst answer = await props.operations.discoverModels(props.provider === "deepseek-official" ? "llm-deepseek" : props.probe.settingsNs, {
\t\t\t\t\t\t...props.probe.provider === void 0 ? {} : { provider: props.probe.provider },
\t\t\t\t\t\t...props.probe.baseURL === void 0 ? {} : { baseURL: props.probe.baseURL },
\t\t\t\t\t\t...props.probe.api === void 0 ? {} : { api: props.probe.api },
\t\t\t\t\t\t...props.probe.apiKey === void 0 ? {} : { apiKey: props.probe.apiKey }
\t\t\t\t\t});
\t\t\t\t\tif (answer.kind === "refused") {
\t\t\t\t\t\tsetFetchMessage(answer.message);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tif (answer.models.length === 0) {
\t\t\t\t\t\tsetFetchMessage(props.t("fetchEmpty"));
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tconst merged = new Map(props.models.map((model) => [model.id, model]));
\t\t\t\t\tfor (const model of answer.models) merged.set(model.id, { ...(merged.get(model.id) ?? {}), ...model });
\t\t\t\t\tprops.onChange([...merged.values()]);
\t\t\t\t} catch (error) {
\t\t\t\t\tsetFetchMessage(error instanceof Error ? error.message : String(error));
\t\t\t\t} finally {
\t\t\t\t\tsetFetching(false);
\t\t\t\t}
\t\t\t};`;
  if (!block.includes(stateToken)) throw new Error("DeepSeek editor state block changed");
  block = block.replace(stateToken, fetchCode);

  const headTail = `}), props.overridden ? (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],
\t\t\t\t\t\t\tdisabled: props.disabled,
\t\t\t\t\t\t\tonClick: reset,
\t\t\t\t\t\t\tchildren: props.t("resetModels")
\t\t\t\t\t\t}) : null]`;
  const fetchButton = `}), props.overridden ? (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],
\t\t\t\t\t\t\tdisabled: props.disabled,
\t\t\t\t\t\t\tonClick: reset,
\t\t\t\t\t\t\tchildren: props.t("resetModels")
\t\t\t\t\t\t}) : null, (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],
\t\t\t\t\t\t\tdisabled: props.disabled || fetching || props.operations === void 0,
\t\t\t\t\t\t\tonClick: fetchFromUpstream,
\t\t\t\t\t\t\tchildren: fetching ? props.t("fetching") : props.t("fetchModels")
\t\t\t\t\t\t})]`;
  if (!block.includes(headTail)) throw new Error("DeepSeek model heading changed");
  block = block.replace(headTail, fetchButton);

  const modelsStart = `\t\t\t\t\tprops.models.length === 0 ?`;
  if (!block.includes(modelsStart)) throw new Error("DeepSeek model list start changed");
  block = block.replace(modelsStart, `\t\t\t\t\tfetchMessage === "" ? null : (0, react_jsx_runtime.jsx)("p", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["error"],
\t\t\t\t\t\tchildren: fetchMessage
\t\t\t\t\t}),
\t\t\t\t\tprops.models.length === 0 ?`);

  const catalogProps = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,`;
  const catalogPropsWithProbe = `\t\t\t\tconst catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\tprovider: props.provider,
\t\t\t\t\toperations,
\t\t\t\t\tprobe,`;
  if (!source.includes(catalogProps)) throw new Error("catalogProps block changed");
  if (!block.includes("fetchFromUpstream")) throw new Error("fetch action was not installed");

  const patchedBlock = block;
  source = source.slice(0, start) + patchedBlock + source.slice(end);
  return source.replace(catalogProps, catalogPropsWithProbe);
});

/**
 * Keep the upstream LLM title provider. Early 1.2.35 builds installed a local
 * shortcut in the rootfs; remove it so the next boot restores the normal extra
 * title request without reinstalling the runtime.
 */
edit("@deepseek-ai/dsh-session-title-llm", "lib/index.js", (source) => {
  if (!source.includes(LOCAL_TITLE_MARKER)) return source;
  const anchor = "\t\tconst route = resolveRoute(config, request);";
  if (!source.includes(anchor)) throw new Error("session title route block changed");
  const shortcut = `${anchor}
\t\t// ${LOCAL_TITLE_MARKER}
\t\tif (route.provider === "dha-local") {
\t\t\tconst sourceText = selectedMessages.flatMap((message) => {
\t\t\t\tif (typeof message.content === "string") return [message.content];
\t\t\t\tif (!Array.isArray(message.content)) return [];
\t\t\t\treturn message.content
\t\t\t\t\t.filter((block) => block && block.type === "text" && typeof block.text === "string")
\t\t\t\t\t.map((block) => block.text);
\t\t\t}).join(" ").replace(/\\s+/gu, " ").trim();
\t\t\tconst title = normalizeSessionTitle(
\t\t\t\t(sourceText || "本地会话").slice(0, 48),
\t\t\t\tNumber.MAX_SAFE_INTEGER
\t\t\t);
\t\t\treturn {
\t\t\t\ttitle,
\t\t\t\tmessageSeqs: selectedMessages.map((message) => message.seq),
\t\t\t\tmodel: route
\t\t\t};
\t\t}`;
  if (!source.includes(shortcut)) throw new Error("local title shortcut block changed");
  return source.replace(shortcut, anchor);
});

edit("@deepseek-ai/dsh-client-ui-conversation", "lib/client.js", (source) => {
  return source
    .replace('"image.modelUnsupported": "当前模型不支持图片，请切换支持图片的模型"',
      '"image.modelUnsupported": "当前模型未启用图片输入，请在 设置 → 模型 → 模型选项 中勾选“图片”"')
    .replace('"image.modelUnsupported": "The current model does not support images; switch to a model that does"',
      '"image.modelUnsupported": "Image input is not enabled for this model. Open Settings → Models → Model options and enable Images."');
});

if (changed === 0) {
  console.log(`repair-model-fetch: nothing to patch (${checked} files checked)`);
}
