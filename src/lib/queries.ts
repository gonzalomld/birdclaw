// Compatibility facade. New code should import the owned read model or action module.
export * from "./query-read-models";
export {
	applyDmRequestMutationToLocalStore,
	type DmRequestMutationAction,
} from "./query-actions";
