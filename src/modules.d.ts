declare module "@joplin/turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	const plugin: { gfm: TurndownService.Plugin };
	export default plugin;
}
