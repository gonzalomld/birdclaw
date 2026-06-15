import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";

export {
	createDmReply,
	createDmReplyEffect,
	createPost,
	createPostEffect,
	createTweetReply,
	createTweetReplyEffect,
} from "./query-read-models";

export type DmRequestMutationAction = "accept" | "reject" | "block";

export async function applyDmRequestMutationToLocalStore(
	conversationId: string,
	action: DmRequestMutationAction,
) {
	return runEffectPromise(
		databaseWriteEffect((db) => {
			db.prepare(
				"delete from sync_cache where cache_key like 'dms:bird:%'",
			).run();
			if (action === "accept") {
				return db
					.prepare(
						`
    update dm_conversations
    set inbox_kind = 'accepted'
    where id = ?
    `,
					)
					.run(conversationId).changes;
			}

			db.prepare(
				`
    delete from link_occurrences
    where source_kind = 'dm'
      and source_id in (
        select id from dm_messages where conversation_id = ?
      )
    `,
			).run(conversationId);
			db.prepare(
				`
    delete from dm_fts
    where message_id in (
      select id from dm_messages where conversation_id = ?
    )
    `,
			).run(conversationId);
			db.prepare("delete from dm_messages where conversation_id = ?").run(
				conversationId,
			);
			return db
				.prepare("delete from dm_conversations where id = ?")
				.run(conversationId).changes;
		}),
	);
}
