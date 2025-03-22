import { handleMessage, postHandleMessage, route } from "@spacebar/api";
import {
	Attachment,
	Config,
	DiscordApiErrors,
	Embed,
	FieldErrors,
	Message,
	MessageCreateEvent,
	Webhook,
	WebhookExecuteSchema,
	emitEvent,
	uploadFile,
} from "@spacebar/util";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server";
import multer from "multer";
import { MoreThan } from "typeorm";
import { WebhookEvent } from "@octokit/webhooks-types";

const router = Router();

// TODO: config max upload size
const messageUpload = multer({
	limits: {
		fileSize: Config.get().limits.message.maxAttachmentSize,
		fields: 10,
		// files: 1
	},
	storage: multer.memoryStorage(),
}); // max upload 50 mb

// https://discord.com/developers/docs/resources/webhook#execute-webhook
// TODO: GitHub/Slack compatible hooks
router.post(
	"/",
	messageUpload.any(),
	(req, res, next) => {
		if (req.body.payload_json) {
			req.body = JSON.parse(req.body.payload_json);
		}

		next();
	},
	route({
		//requestBody: "GithubCompatibleWebhookSchema",
		query: {
			wait: {
				type: "boolean",
				required: false,
				description:
					"waits for server confirmation of message send before response, and returns the created message body",
			},
			thread_id: {
				type: "string",
				required: false,
				description:
					"Send a message to the specified thread within a webhook's channel.",
			},
		},
		responses: {
			204: {},
			400: {
				body: "APIErrorResponse",
			},
			404: {},
		},
	}),
	async (req: Request, res: Response) => {
		const { wait } = req.query;
		//if (!wait) res.status(204).send();

		const { webhook_id, token } = req.params;

		const attachments: Attachment[] = [];

		const webhook = await Webhook.findOne({
			where: {
				id: webhook_id,
			},
			relations: ["channel", "guild", "application"],
		});

		if (!webhook) {
			throw DiscordApiErrors.UNKNOWN_WEBHOOK;
		}

		if (webhook.token !== token) {
			throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;
		}

		if (!webhook.channel.isWritable()) {
			throw new HTTPError(
				`Cannot send messages to channel of type ${webhook.channel.type}`,
				400,
			);
		}

		// TODO: creating messages by users checks if the user can bypass rate limits, we cant do that on webhooks, but maybe we could check the application if there is one?
		const limits = Config.get().limits;
		if (limits.absoluteRate.register.enabled) {
			const count = await Message.count({
				where: {
					channel_id: webhook.channel_id,
					timestamp: MoreThan(
						new Date(
							Date.now() - limits.absoluteRate.sendMessage.window,
						),
					),
				},
			});

			if (count >= limits.absoluteRate.sendMessage.limit)
				throw FieldErrors({
					channel_id: {
						code: "TOO_MANY_MESSAGES",
						message: req.t("common:toomany.MESSAGE"),
					},
				});
		}

		const body = req.body as object;
		let message: Message;
		function getUserInfo(obj: unknown) {
			if (
				typeof obj === "object" &&
				obj !== null &&
				"user" in obj &&
				typeof obj.user === "object" &&
				obj.user !== null
			) {
				const user = obj.user;

				return {
					login: getStringOrFail(user, "login"),
					avatar: getStringOrFail(user, "avatar_url"),
					url: getStringOrFail(user, "html_url"),
				};
			}
			throw new Error("catch me");
		}
		function getStringOrFail(obj: unknown, val: string) {
			//@ts-expect-error error is supposed to happen
			const valy = obj[val];
			if (typeof valy !== "string") {
				throw new Error("catch me");
			}
			return valy;
		}
		function getNumberOrFail(obj: unknown, val: string) {
			//@ts-expect-error error is supposed to happen
			const valy = obj[val];
			if (typeof valy !== "number") {
				throw new Error("catch me");
			}
			return valy;
		}
		try {
			if ("event" in body) {
				console.log("event");
				if (
					"payload" in body &&
					typeof body.payload === "object" &&
					body.payload !== null
				) {
					console.log("pay");
					const payload = body.payload as { repository: unknown };
					let embed: Embed;
					console.log(body.event);
					const repo = {
						full_name: getStringOrFail(
							payload["repository"],
							"full_name",
						),
					};
					switch (body.event) {
						case "issue_comment":
						case "issues":
							console.log("issues");
							if (
								"issue" in payload &&
								typeof payload.issue === "object" &&
								payload.issue !== null
							) {
								const user = getUserInfo(payload.issue);
								if (!user) return res.status(204).send();
								//console.log(body, user);
								embed = {};
								let action: string;
								switch (
									(action = getStringOrFail(
										payload,
										"action",
									))
								) {
									case "closed":
									case "opened":
									case "reopened":
									case "deleted":
									case "locked":
									case "pinned":
									case "unlocked":
									case "unpinned":
									case "milestoned":
									case "demilestoned":
										console.log(
											"body",
											"user",
											payload.issue,
										);
										embed.author = {
											name: user.login,
											icon_url: user.avatar,
											url: user.url,
										};
										embed.title = `[${repo.full_name}] Issue ${action}: #${getNumberOrFail(payload.issue, "number")} ${getStringOrFail(payload.issue, "title")}`;

										embed.url = getStringOrFail(
											payload.issue,
											"html_url",
										);
										break;
									case "created": {
										if (
											!(
												"comment" in payload &&
												typeof payload.comment ==
													"object" &&
												payload.comment !== null
											)
										) {
											throw new Error();
										}
										const user = getUserInfo(
											payload.comment,
										);
										embed.author = {
											name: user.login,
											icon_url: user.avatar,
											url: user.url,
										};
										embed.title = `[${repo.full_name}] Comment on issue: #${getNumberOrFail(payload.issue, "number")} ${getStringOrFail(payload.issue, "title")}`;
										embed.description = getStringOrFail(
											payload.comment,
											"body",
										);
										embed.url = getStringOrFail(
											payload.issue,
											"repository_url",
										);
										break;
									}
									default:
										console.error(payload.action);
								}
								console.log(embed);
							} else {
								return res.status(204).send();
							}
							message = await handleMessage({
								type: 0,
								pinned: false,
								webhook_id: webhook.id,
								application_id: webhook.application?.id,
								embeds: [embed],
								// TODO: Support thread_id/thread_name once threads are implemented
								channel_id: webhook.channel_id,
								attachments,
								timestamp: new Date(),
							});
							break;
						default:
							return res.status(204).send();
					}
				} else {
					return res.status(204).send();
				}
			} else {
				return res.status(204).send();
			}
		} catch {
			return res.status(204).send();
		}
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		//@ts-ignore dont care2
		message.edited_timestamp = null;

		webhook.channel.last_message_id = message.id;

		await Promise.all([
			message.save(),
			emitEvent({
				event: "MESSAGE_CREATE",
				channel_id: webhook.channel_id,
				data: message,
			} as MessageCreateEvent),
		]);

		// no await as it shouldnt block the message send function and silently catch error
		postHandleMessage(message).catch((e) =>
			console.error("[Message] post-message handler failed", e),
		);

		return res.json(message);
	},
);

export default router;
