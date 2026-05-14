// See https://kit.svelte.dev/docs/types#app
declare global {
	namespace App {
		interface Locals {
			userId: string | null;
			user: import('$lib/types').User | null;
			csrfToken: string;
		}
		interface PageData {
			user: import('$lib/types').User | null;
		}
		interface Error {
			message: string;
			code?: string;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
