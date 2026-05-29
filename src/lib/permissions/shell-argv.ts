import type { ShellOptionSpec } from './scope-types';

export interface MatchedShellOption {
	spec: ShellOptionSpec;
	index: number;
	value?: string;
	valueIndex?: number;
}

export function looksLikeShellOptionToken(tok: string | undefined): boolean {
	return typeof tok === 'string' && tok.startsWith('-') && tok !== '-';
}

export function resolveSubcommandIndex(
	argv: string[],
	allowedOptions: readonly ShellOptionSpec[]
): { subcommandIndex: number | null; matchedOptions: MatchedShellOption[] } {
	const matchedOptions: MatchedShellOption[] = [];
	for (let i = 1; i < argv.length; ) {
		const tok = argv[i];
		if (tok === '--') return { subcommandIndex: null, matchedOptions };
		if (!looksLikeShellOptionToken(tok)) {
			return { subcommandIndex: i, matchedOptions };
		}
		const matched = matchShellOptionToken(tok, argv[i + 1], allowedOptions);
		if (!matched) return { subcommandIndex: null, matchedOptions };
		matchedOptions.push({
			spec: matched.spec,
			index: i,
			value: matched.value,
			valueIndex: matched.consumedNextToken ? i + 1 : undefined
		});
		i += matched.consumedNextToken ? 2 : 1;
	}
	return { subcommandIndex: null, matchedOptions };
}

export function matchShellOptionToken(
	tok: string,
	nextTok: string | undefined,
	specs: readonly ShellOptionSpec[]
): { spec: ShellOptionSpec; value?: string; consumedNextToken: boolean } | null {
	for (const spec of specs) {
		if (spec.kind === 'flag') {
			if (tok === spec.name) return { spec, consumedNextToken: false };
			continue;
		}

		if (tok === spec.name) {
			if (nextTok === undefined) return null;
			return { spec, value: nextTok, consumedNextToken: true };
		}
		if (tok.startsWith(spec.name + '=')) {
			return {
				spec,
				value: tok.slice(spec.name.length + 1),
				consumedNextToken: false
			};
		}
	}
	return null;
}
