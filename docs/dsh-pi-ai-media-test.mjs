const { toStreamChunks } = await import(process.env.DSH_PI_AI_MODULE
	?? "/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js");

function check(condition, message) {
	if (!condition) throw new Error(message);
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xz2nAAAAAElFTkSuQmCC";
const attachment = {
	attachmentId: "sha256:generated",
	mediaType: "image/png",
	bytes: 68,
	width: 1,
	height: 1,
};
let saved;

async function* events() {
	yield {
		type: "done",
		message: {
			api: "openai-responses",
			provider: "test",
			model: "test-image",
			content: [
				{ type: "text", text: "generated" },
				{ type: "image", mimeType: "image/png", data: png },
			],
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

const chunks = [];
for await (const chunk of toStreamChunks(events(), 1000, undefined, "test-image", {
	async saveImages(inputs) {
		saved = inputs;
		return [attachment];
	},
})) chunks.push(chunk);

check(saved?.length === 1, "generated image was not handed to attachment storage");
check(saved[0].mediaType === "image/png", "generated image media type was lost");
check(saved[0].data instanceof Uint8Array && saved[0].data.length > 0, "generated image bytes were not decoded");

const imageBlock = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "image");
check(imageBlock !== undefined, "generated image block was not emitted");
check(imageBlock.index === 1, `generated image block used index ${imageBlock.index}`);
check(imageBlock.block.attachment === attachment, "generated image attachment was not retained");

const finish = chunks.find((chunk) => chunk.type === "finish");
check(finish?.replayState?.blocks?.length === 2, "replay metadata does not align with text and image blocks");
check(finish.replayState.blocks[1]?.type === "image", "replay metadata omitted the generated image");

console.log("dsh pi-ai media: 7 checks, 0 failure(s)");
