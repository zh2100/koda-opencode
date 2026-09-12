import type { HealthGetOutput, LocationGetInput, LocationGetOutput, AgentsListInput, AgentsListOutput, SessionsListInput, SessionsListOutput, SessionsCreateInput, SessionsGetInput, SessionsSwitchAgentInput, SessionsSwitchModelInput, SessionsPromptInput, SessionsCompactInput, SessionsWaitInput, SessionsStageInput, SessionsClearInput, SessionsCommitInput, SessionsContextInput, SessionsHistoryInput, SessionsHistoryOutput, SessionsEventsInput, SessionsEventsOutput, SessionsInterruptInput, SessionsResumeInput, SessionsMessageInput, MessagesListInput, MessagesListOutput, ModelsListInput, ModelsListOutput, ProvidersListInput, ProvidersListOutput, ProvidersGetInput, ProvidersGetOutput, IntegrationsListInput, IntegrationsListOutput, IntegrationsGetInput, IntegrationsGetOutput, IntegrationsConnectKeyInput, IntegrationsConnectOauthInput, IntegrationsConnectOauthOutput, IntegrationsAttemptStatusInput, IntegrationsAttemptStatusOutput, IntegrationsAttemptCompleteInput, IntegrationsAttemptCancelInput, CredentialsUpdateInput, CredentialsRemoveInput, ServerRelayGetInput, ServerRelayGetOutput, ServerRelayModeInput, ServerRelayModeOutput, ServerRelayUnifiedInput, ServerRelayUnifiedOutput, ServerRelayClearInput, ServerRelayClearOutput, ServerRelayVendorInput, ServerRelayVendorOutput, ServerRelayKeyInput, ServerRelayKeyOutput, ServerRelayDeleteInput, ServerRelayDeleteOutput, ServerRelayRollbackInput, ServerRelayRollbackOutput, ServerRelayProbeInput, ServerRelayProbeOutput, ServerRelayRefreshInput, ServerRelayRefreshOutput, ServerRelayManagedInput, ServerRelayManagedOutput, ServerRelayCandidatesInput, ServerRelayCandidatesOutput, ServerRelayVisibilityInput, ServerRelayVisibilityOutput, ServerScheduledTaskListOutput, ServerScheduledTaskCreateInput, ServerScheduledTaskCreateOutput, ServerScheduledTaskRunsInput, ServerScheduledTaskRunsOutput, ServerScheduledTaskRunInput, ServerScheduledTaskRunOutput, ServerScheduledTaskEnableInput, ServerScheduledTaskEnableOutput, PermissionsListRequestsInput, PermissionsListRequestsOutput, PermissionsListSavedInput, PermissionsAddInput, PermissionsRemoveSavedInput, PermissionsCreateInput, PermissionsListInput, PermissionsGetInput, PermissionsReplyInput, FilesListInput, FilesListOutput, FilesFindInput, FilesFindOutput, CommandsListInput, CommandsListOutput, SkillsListInput, SkillsListOutput, PtysListInput, PtysListOutput, PtysCreateInput, PtysCreateOutput, PtysGetInput, PtysGetOutput, PtysUpdateInput, PtysUpdateOutput, PtysRemoveInput, QuestionsListRequestsInput, QuestionsListRequestsOutput, QuestionsListInput, QuestionsReplyInput, QuestionsRejectInput, ReferencesListInput, ReferencesListOutput, ProjectCopiesCreateInput, ProjectCopiesCreateOutput, ProjectCopiesRemoveInput, ProjectCopiesRefreshInput } from "./types";
export interface ClientOptions {
    readonly baseUrl: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
}
export interface RequestOptions {
    readonly signal?: AbortSignal;
    readonly headers?: HeadersInit;
}
export declare function make(options: ClientOptions): {
    health: {
        get: (requestOptions?: RequestOptions | undefined) => Promise<HealthGetOutput>;
    };
    location: {
        get: (input?: LocationGetInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<LocationGetOutput>;
    };
    agents: {
        list: (input?: AgentsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<AgentsListOutput>;
    };
    sessions: {
        list: (input?: SessionsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<SessionsListOutput>;
        create: (input?: SessionsCreateInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly id: string;
            readonly parentID?: string | undefined;
            readonly projectID: string;
            readonly agent?: string | undefined;
            readonly model?: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            } | undefined;
            readonly cost: number;
            readonly tokens: {
                readonly input: number;
                readonly output: number;
                readonly reasoning: number;
                readonly cache: {
                    readonly read: number;
                    readonly write: number;
                };
            };
            readonly time: {
                readonly created: number;
                readonly updated: number;
                readonly archived?: number | undefined;
            };
            readonly title: string;
            readonly location: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            };
            readonly subpath?: string | undefined;
            readonly revert?: {
                readonly messageID: string;
                readonly partID?: string | undefined;
                readonly snapshot?: string | undefined;
                readonly diff?: string | undefined;
                readonly files?: readonly {
                    readonly path: string;
                    readonly status: "added" | "deleted" | "modified";
                    readonly additions: number;
                    readonly deletions: number;
                    readonly patch: string;
                }[] | undefined;
            } | undefined;
        }>;
        active: (requestOptions?: RequestOptions | undefined) => Promise<{
            readonly [x: string]: {
                readonly type: "running";
            };
        }>;
        get: (input: SessionsGetInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly id: string;
            readonly parentID?: string | undefined;
            readonly projectID: string;
            readonly agent?: string | undefined;
            readonly model?: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            } | undefined;
            readonly cost: number;
            readonly tokens: {
                readonly input: number;
                readonly output: number;
                readonly reasoning: number;
                readonly cache: {
                    readonly read: number;
                    readonly write: number;
                };
            };
            readonly time: {
                readonly created: number;
                readonly updated: number;
                readonly archived?: number | undefined;
            };
            readonly title: string;
            readonly location: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            };
            readonly subpath?: string | undefined;
            readonly revert?: {
                readonly messageID: string;
                readonly partID?: string | undefined;
                readonly snapshot?: string | undefined;
                readonly diff?: string | undefined;
                readonly files?: readonly {
                    readonly path: string;
                    readonly status: "added" | "deleted" | "modified";
                    readonly additions: number;
                    readonly deletions: number;
                    readonly patch: string;
                }[] | undefined;
            } | undefined;
        }>;
        switchAgent: (input: SessionsSwitchAgentInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        switchModel: (input: SessionsSwitchModelInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        prompt: (input: SessionsPromptInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly admittedSeq: number;
            readonly id: string;
            readonly sessionID: string;
            readonly prompt: {
                readonly text: string;
                readonly files?: readonly {
                    readonly uri: string;
                    readonly mime: string;
                    readonly name?: string | undefined;
                    readonly description?: string | undefined;
                    readonly source?: {
                        readonly start: number;
                        readonly end: number;
                        readonly text: string;
                    } | undefined;
                }[] | undefined;
                readonly agents?: readonly {
                    readonly name: string;
                    readonly source?: {
                        readonly start: number;
                        readonly end: number;
                        readonly text: string;
                    } | undefined;
                }[] | undefined;
            };
            readonly delivery: "queue" | "steer";
            readonly timeCreated: number;
            readonly promotedSeq?: number | undefined;
        }>;
        compact: (input: SessionsCompactInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        wait: (input: SessionsWaitInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        stage: (input: SessionsStageInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly messageID: string;
            readonly partID?: string | undefined;
            readonly snapshot?: string | undefined;
            readonly diff?: string | undefined;
            readonly files?: readonly {
                readonly path: string;
                readonly status: "added" | "deleted" | "modified";
                readonly additions: number;
                readonly deletions: number;
                readonly patch: string;
            }[] | undefined;
        }>;
        clear: (input: SessionsClearInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        commit: (input: SessionsCommitInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        context: (input: SessionsContextInput, requestOptions?: RequestOptions | undefined) => Promise<readonly ({
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "agent-switched";
            readonly agent: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "model-switched";
            readonly model: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly text: string;
            readonly files?: readonly {
                readonly uri: string;
                readonly mime: string;
                readonly name?: string | undefined;
                readonly description?: string | undefined;
                readonly source?: {
                    readonly start: number;
                    readonly end: number;
                    readonly text: string;
                } | undefined;
            }[] | undefined;
            readonly agents?: readonly {
                readonly name: string;
                readonly source?: {
                    readonly start: number;
                    readonly end: number;
                    readonly text: string;
                } | undefined;
            }[] | undefined;
            readonly type: "user";
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly sessionID: string;
            readonly text: string;
            readonly type: "synthetic";
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "system";
            readonly text: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
                readonly completed?: number | undefined;
            };
            readonly type: "shell";
            readonly callID: string;
            readonly command: string;
            readonly output: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
                readonly completed?: number | undefined;
            };
            readonly type: "assistant";
            readonly agent: string;
            readonly model: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            };
            readonly content: readonly ({
                readonly type: "text";
                readonly id: string;
                readonly text: string;
            } | {
                readonly type: "reasoning";
                readonly id: string;
                readonly text: string;
                readonly providerMetadata?: {
                    readonly [x: string]: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                } | undefined;
                readonly time?: {
                    readonly created: number;
                    readonly completed?: number | undefined;
                } | undefined;
            } | {
                readonly type: "tool";
                readonly id: string;
                readonly name: string;
                readonly provider?: {
                    readonly executed: boolean;
                    readonly metadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: import("./types").JsonValue;
                        };
                    } | undefined;
                    readonly resultMetadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: import("./types").JsonValue;
                        };
                    } | undefined;
                } | undefined;
                readonly state: {
                    readonly status: "pending";
                    readonly input: string;
                } | {
                    readonly status: "running";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                } | {
                    readonly status: "completed";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly attachments?: readonly {
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                        readonly description?: string | undefined;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                    readonly outputPaths?: readonly string[] | undefined;
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly result?: import("./types").JsonValue | undefined;
                } | {
                    readonly status: "error";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly error: {
                        readonly type: "unknown";
                        readonly message: string;
                    };
                    readonly result?: import("./types").JsonValue | undefined;
                };
                readonly time: {
                    readonly created: number;
                    readonly ran?: number | undefined;
                    readonly completed?: number | undefined;
                    readonly pruned?: number | undefined;
                };
            })[];
            readonly snapshot?: {
                readonly start?: string | undefined;
                readonly end?: string | undefined;
                readonly files?: readonly string[] | undefined;
            } | undefined;
            readonly finish?: string | undefined;
            readonly cost?: number | undefined;
            readonly tokens?: {
                readonly input: number;
                readonly output: number;
                readonly reasoning: number;
                readonly cache: {
                    readonly read: number;
                    readonly write: number;
                };
            } | undefined;
            readonly error?: {
                readonly type: "unknown";
                readonly message: string;
            } | undefined;
        } | {
            readonly type: "compaction";
            readonly reason: "auto" | "manual";
            readonly summary: string;
            readonly recent: string;
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
        })[]>;
        history: (input: SessionsHistoryInput, requestOptions?: RequestOptions | undefined) => Promise<SessionsHistoryOutput>;
        events: (input: SessionsEventsInput, requestOptions?: RequestOptions | undefined) => AsyncIterable<SessionsEventsOutput>;
        interrupt: (input: SessionsInterruptInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        resume: (input: SessionsResumeInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        message: (input: SessionsMessageInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "agent-switched";
            readonly agent: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "model-switched";
            readonly model: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly text: string;
            readonly files?: readonly {
                readonly uri: string;
                readonly mime: string;
                readonly name?: string | undefined;
                readonly description?: string | undefined;
                readonly source?: {
                    readonly start: number;
                    readonly end: number;
                    readonly text: string;
                } | undefined;
            }[] | undefined;
            readonly agents?: readonly {
                readonly name: string;
                readonly source?: {
                    readonly start: number;
                    readonly end: number;
                    readonly text: string;
                } | undefined;
            }[] | undefined;
            readonly type: "user";
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly sessionID: string;
            readonly text: string;
            readonly type: "synthetic";
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
            readonly type: "system";
            readonly text: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
                readonly completed?: number | undefined;
            };
            readonly type: "shell";
            readonly callID: string;
            readonly command: string;
            readonly output: string;
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
                readonly completed?: number | undefined;
            };
            readonly type: "assistant";
            readonly agent: string;
            readonly model: {
                readonly id: string;
                readonly providerID: string;
                readonly variant?: string | undefined;
            };
            readonly content: readonly ({
                readonly type: "text";
                readonly id: string;
                readonly text: string;
            } | {
                readonly type: "reasoning";
                readonly id: string;
                readonly text: string;
                readonly providerMetadata?: {
                    readonly [x: string]: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                } | undefined;
                readonly time?: {
                    readonly created: number;
                    readonly completed?: number | undefined;
                } | undefined;
            } | {
                readonly type: "tool";
                readonly id: string;
                readonly name: string;
                readonly provider?: {
                    readonly executed: boolean;
                    readonly metadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: import("./types").JsonValue;
                        };
                    } | undefined;
                    readonly resultMetadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: import("./types").JsonValue;
                        };
                    } | undefined;
                } | undefined;
                readonly state: {
                    readonly status: "pending";
                    readonly input: string;
                } | {
                    readonly status: "running";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                } | {
                    readonly status: "completed";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly attachments?: readonly {
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                        readonly description?: string | undefined;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                    readonly outputPaths?: readonly string[] | undefined;
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly result?: import("./types").JsonValue | undefined;
                } | {
                    readonly status: "error";
                    readonly input: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly content: readonly ({
                        readonly type: "text";
                        readonly text: string;
                    } | {
                        readonly type: "file";
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                    })[];
                    readonly structured: {
                        readonly [x: string]: import("./types").JsonValue;
                    };
                    readonly error: {
                        readonly type: "unknown";
                        readonly message: string;
                    };
                    readonly result?: import("./types").JsonValue | undefined;
                };
                readonly time: {
                    readonly created: number;
                    readonly ran?: number | undefined;
                    readonly completed?: number | undefined;
                    readonly pruned?: number | undefined;
                };
            })[];
            readonly snapshot?: {
                readonly start?: string | undefined;
                readonly end?: string | undefined;
                readonly files?: readonly string[] | undefined;
            } | undefined;
            readonly finish?: string | undefined;
            readonly cost?: number | undefined;
            readonly tokens?: {
                readonly input: number;
                readonly output: number;
                readonly reasoning: number;
                readonly cache: {
                    readonly read: number;
                    readonly write: number;
                };
            } | undefined;
            readonly error?: {
                readonly type: "unknown";
                readonly message: string;
            } | undefined;
        } | {
            readonly type: "compaction";
            readonly reason: "auto" | "manual";
            readonly summary: string;
            readonly recent: string;
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly time: {
                readonly created: number;
            };
        }>;
    };
    messages: {
        list: (input: MessagesListInput, requestOptions?: RequestOptions | undefined) => Promise<MessagesListOutput>;
    };
    models: {
        list: (input?: ModelsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ModelsListOutput>;
    };
    providers: {
        list: (input?: ProvidersListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ProvidersListOutput>;
        get: (input: ProvidersGetInput, requestOptions?: RequestOptions | undefined) => Promise<ProvidersGetOutput>;
    };
    integrations: {
        list: (input?: IntegrationsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<IntegrationsListOutput>;
        get: (input: IntegrationsGetInput, requestOptions?: RequestOptions | undefined) => Promise<IntegrationsGetOutput>;
        connectKey: (input: IntegrationsConnectKeyInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        connectOauth: (input: IntegrationsConnectOauthInput, requestOptions?: RequestOptions | undefined) => Promise<IntegrationsConnectOauthOutput>;
        attemptStatus: (input: IntegrationsAttemptStatusInput, requestOptions?: RequestOptions | undefined) => Promise<IntegrationsAttemptStatusOutput>;
        attemptComplete: (input: IntegrationsAttemptCompleteInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        attemptCancel: (input: IntegrationsAttemptCancelInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
    credentials: {
        update: (input: CredentialsUpdateInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        remove: (input: CredentialsRemoveInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
    "server.relay": {
        get: (input?: ServerRelayGetInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayGetOutput>;
        mode: (input: ServerRelayModeInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayModeOutput>;
        unified: (input: ServerRelayUnifiedInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayUnifiedOutput>;
        clear: (input: ServerRelayClearInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayClearOutput>;
        vendor: (input: ServerRelayVendorInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayVendorOutput>;
        key: (input: ServerRelayKeyInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayKeyOutput>;
        delete: (input: ServerRelayDeleteInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayDeleteOutput>;
        rollback: (input: ServerRelayRollbackInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayRollbackOutput>;
        probe: (input: ServerRelayProbeInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayProbeOutput>;
        refresh: (input: ServerRelayRefreshInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayRefreshOutput>;
        managed: (input?: ServerRelayManagedInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayManagedOutput>;
        candidates: (input?: ServerRelayCandidatesInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayCandidatesOutput>;
        visibility: (input: ServerRelayVisibilityInput, requestOptions?: RequestOptions | undefined) => Promise<ServerRelayVisibilityOutput>;
    };
    "server.scheduledTask": {
        list: (requestOptions?: RequestOptions | undefined) => Promise<ServerScheduledTaskListOutput>;
        create: (input: ServerScheduledTaskCreateInput, requestOptions?: RequestOptions | undefined) => Promise<ServerScheduledTaskCreateOutput>;
        runs: (input: ServerScheduledTaskRunsInput, requestOptions?: RequestOptions | undefined) => Promise<ServerScheduledTaskRunsOutput>;
        run: (input: ServerScheduledTaskRunInput, requestOptions?: RequestOptions | undefined) => Promise<ServerScheduledTaskRunOutput>;
        enable: (input: ServerScheduledTaskEnableInput, requestOptions?: RequestOptions | undefined) => Promise<ServerScheduledTaskEnableOutput>;
    };
    permissions: {
        listRequests: (input?: PermissionsListRequestsInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<PermissionsListRequestsOutput>;
        listSaved: (input?: PermissionsListSavedInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<readonly {
            readonly id: string;
            readonly projectID: string;
            readonly action: string;
            readonly resource: string;
            readonly effect?: "allow" | "ask" | "deny" | null | undefined;
        }[]>;
        add: (input: PermissionsAddInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        removeSaved: (input: PermissionsRemoveSavedInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        create: (input: PermissionsCreateInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly id: string;
            readonly effect: "allow" | "ask" | "deny";
        }>;
        list: (input: PermissionsListInput, requestOptions?: RequestOptions | undefined) => Promise<readonly {
            readonly id: string;
            readonly sessionID: string;
            readonly action: string;
            readonly resources: readonly string[];
            readonly save?: readonly string[] | undefined;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly source?: {
                readonly type: "tool";
                readonly messageID: string;
                readonly callID: string;
            } | undefined;
        }[]>;
        get: (input: PermissionsGetInput, requestOptions?: RequestOptions | undefined) => Promise<{
            readonly id: string;
            readonly sessionID: string;
            readonly action: string;
            readonly resources: readonly string[];
            readonly save?: readonly string[] | undefined;
            readonly metadata?: {
                readonly [x: string]: import("./types").JsonValue;
            } | undefined;
            readonly source?: {
                readonly type: "tool";
                readonly messageID: string;
                readonly callID: string;
            } | undefined;
        }>;
        reply: (input: PermissionsReplyInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
    files: {
        list: (input?: FilesListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<FilesListOutput>;
        find: (input: FilesFindInput, requestOptions?: RequestOptions | undefined) => Promise<FilesFindOutput>;
    };
    commands: {
        list: (input?: CommandsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<CommandsListOutput>;
    };
    skills: {
        list: (input?: SkillsListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<SkillsListOutput>;
    };
    events: {
        subscribe: (requestOptions?: RequestOptions | undefined) => AsyncIterable<{
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.agent.switched";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly agent: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.model.switched";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly model: {
                    readonly id: string;
                    readonly providerID: string;
                    readonly variant?: string | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.moved";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly location: {
                    readonly directory: string;
                    readonly workspaceID?: string | undefined;
                };
                readonly subdirectory?: string | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.prompted";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly prompt: {
                    readonly text: string;
                    readonly files?: readonly {
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                        readonly description?: string | undefined;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                    readonly agents?: readonly {
                        readonly name: string;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                };
                readonly delivery: "queue" | "steer";
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.prompt.admitted";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly prompt: {
                    readonly text: string;
                    readonly files?: readonly {
                        readonly uri: string;
                        readonly mime: string;
                        readonly name?: string | undefined;
                        readonly description?: string | undefined;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                    readonly agents?: readonly {
                        readonly name: string;
                        readonly source?: {
                            readonly start: number;
                            readonly end: number;
                            readonly text: string;
                        } | undefined;
                    }[] | undefined;
                };
                readonly delivery: "queue" | "steer";
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.context.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly text: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.synthetic";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly text: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.shell.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly callID: string;
                readonly command: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.shell.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly callID: string;
                readonly output: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.step.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly agent: string;
                readonly model: {
                    readonly id: string;
                    readonly providerID: string;
                    readonly variant?: string | undefined;
                };
                readonly snapshot?: string | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.step.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly finish: string;
                readonly cost: number;
                readonly tokens: {
                    readonly input: number;
                    readonly output: number;
                    readonly reasoning: number;
                    readonly cache: {
                        readonly read: number;
                        readonly write: number;
                    };
                };
                readonly snapshot?: string | undefined;
                readonly files?: readonly string[] | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.step.failed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly error: {
                    readonly type: "unknown";
                    readonly message: string;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.text.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly textID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.text.delta";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly textID: string;
                readonly delta: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.text.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly textID: string;
                readonly text: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.reasoning.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly reasoningID: string;
                readonly providerMetadata?: {
                    readonly [x: string]: {
                        readonly [x: string]: unknown;
                    };
                } | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.reasoning.delta";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly reasoningID: string;
                readonly delta: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.reasoning.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly reasoningID: string;
                readonly text: string;
                readonly providerMetadata?: {
                    readonly [x: string]: {
                        readonly [x: string]: unknown;
                    };
                } | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.input.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly name: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.input.delta";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly delta: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.input.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly text: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.called";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly tool: string;
                readonly input: {
                    readonly [x: string]: unknown;
                };
                readonly provider: {
                    readonly executed: boolean;
                    readonly metadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: unknown;
                        };
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.progress";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly structured: {
                    readonly [x: string]: unknown;
                };
                readonly content: readonly ({
                    readonly type: "text";
                    readonly text: string;
                } | {
                    readonly type: "file";
                    readonly uri: string;
                    readonly mime: string;
                    readonly name?: string | undefined;
                })[];
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.success";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly structured: {
                    readonly [x: string]: unknown;
                };
                readonly content: readonly ({
                    readonly type: "text";
                    readonly text: string;
                } | {
                    readonly type: "file";
                    readonly uri: string;
                    readonly mime: string;
                    readonly name?: string | undefined;
                })[];
                readonly outputPaths?: readonly string[] | undefined;
                readonly result?: unknown;
                readonly provider: {
                    readonly executed: boolean;
                    readonly metadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: unknown;
                        };
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.tool.failed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly assistantMessageID: string;
                readonly callID: string;
                readonly error: {
                    readonly type: "unknown";
                    readonly message: string;
                };
                readonly result?: unknown;
                readonly provider: {
                    readonly executed: boolean;
                    readonly metadata?: {
                        readonly [x: string]: {
                            readonly [x: string]: unknown;
                        };
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.retried";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly attempt: number;
                readonly error: {
                    readonly message: string;
                    readonly statusCode?: number | undefined;
                    readonly isRetryable: boolean;
                    readonly responseHeaders?: {
                        readonly [x: string]: string;
                    } | undefined;
                    readonly responseBody?: string | undefined;
                    readonly metadata?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.compaction.started";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly reason: "auto" | "manual";
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.compaction.delta";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly text: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.compaction.ended";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
                readonly reason: "auto" | "manual";
                readonly text: string;
                readonly recent: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.revert.cleared";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.revert.committed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly messageID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.next.revert.staged";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly timestamp: number;
                readonly sessionID: string;
                readonly revert: {
                    readonly messageID: string;
                    readonly partID?: string | undefined;
                    readonly snapshot?: string | undefined;
                    readonly diff?: string | undefined;
                    readonly files?: readonly {
                        readonly path: string;
                        readonly status: "added" | "deleted" | "modified";
                        readonly additions: number;
                        readonly deletions: number;
                        readonly patch: string;
                    }[] | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "message.part.delta";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly messageID: string;
                readonly partID: string;
                readonly field: string;
                readonly delta: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "message.part.removed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly messageID: string;
                readonly partID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "message.part.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly part: {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "snapshot";
                    readonly snapshot: string;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "patch";
                    readonly hash: string;
                    readonly files: readonly string[];
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "text";
                    readonly text: string;
                    readonly synthetic?: boolean | undefined;
                    readonly ignored?: boolean | undefined;
                    readonly time?: {
                        readonly start: number;
                        readonly end?: number | undefined;
                    } | undefined;
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "reasoning";
                    readonly text: string;
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                    readonly time: {
                        readonly start: number;
                        readonly end?: number | undefined;
                    };
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "file";
                    readonly mime: string;
                    readonly filename?: string | undefined;
                    readonly url: string;
                    readonly source?: {
                        readonly text: {
                            readonly value: string;
                            readonly start: number;
                            readonly end: number;
                        };
                        readonly type: "file";
                        readonly path: string;
                    } | {
                        readonly text: {
                            readonly value: string;
                            readonly start: number;
                            readonly end: number;
                        };
                        readonly type: "symbol";
                        readonly path: string;
                        readonly range: {
                            readonly start: {
                                readonly line: number;
                                readonly character: number;
                            };
                            readonly end: {
                                readonly line: number;
                                readonly character: number;
                            };
                        };
                        readonly name: string;
                        readonly kind: number;
                    } | {
                        readonly text: {
                            readonly value: string;
                            readonly start: number;
                            readonly end: number;
                        };
                        readonly type: "resource";
                        readonly clientName: string;
                        readonly uri: string;
                    } | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "agent";
                    readonly name: string;
                    readonly source?: {
                        readonly value: string;
                        readonly start: number;
                        readonly end: number;
                    } | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "compaction";
                    readonly auto: boolean;
                    readonly overflow?: boolean | undefined;
                    readonly tail_start_id?: string | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "subtask";
                    readonly prompt: string;
                    readonly description: string;
                    readonly agent: string;
                    readonly model?: {
                        readonly providerID: string;
                        readonly modelID: string;
                    } | undefined;
                    readonly command?: string | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "retry";
                    readonly attempt: number;
                    readonly error: {
                        readonly name: "APIError";
                        readonly data: {
                            readonly message: string;
                            readonly statusCode?: number | undefined;
                            readonly isRetryable: boolean;
                            readonly responseHeaders?: {
                                readonly [x: string]: string;
                            } | undefined;
                            readonly responseBody?: string | undefined;
                            readonly metadata?: {
                                readonly [x: string]: string;
                            } | undefined;
                        };
                    };
                    readonly time: {
                        readonly created: number;
                    };
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "step-start";
                    readonly snapshot?: string | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "step-finish";
                    readonly reason: string;
                    readonly snapshot?: string | undefined;
                    readonly cost: number;
                    readonly tokens: {
                        readonly total?: number | undefined;
                        readonly input: number;
                        readonly output: number;
                        readonly reasoning: number;
                        readonly cache: {
                            readonly read: number;
                            readonly write: number;
                        };
                    };
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly messageID: string;
                    readonly type: "tool";
                    readonly callID: string;
                    readonly tool: string;
                    readonly state: {
                        readonly status: "pending";
                        readonly input: {
                            readonly [x: string]: any;
                        };
                        readonly raw: string;
                    } | {
                        readonly status: "running";
                        readonly input: {
                            readonly [x: string]: any;
                        };
                        readonly title?: string | undefined;
                        readonly metadata?: {
                            readonly [x: string]: any;
                        } | undefined;
                        readonly time: {
                            readonly start: number;
                        };
                    } | {
                        readonly status: "completed";
                        readonly input: {
                            readonly [x: string]: any;
                        };
                        readonly output: string;
                        readonly title: string;
                        readonly metadata: {
                            readonly [x: string]: any;
                        };
                        readonly time: {
                            readonly start: number;
                            readonly end: number;
                            readonly compacted?: number | undefined;
                        };
                        readonly attachments?: readonly {
                            readonly id: string;
                            readonly sessionID: string;
                            readonly messageID: string;
                            readonly type: "file";
                            readonly mime: string;
                            readonly filename?: string | undefined;
                            readonly url: string;
                            readonly source?: {
                                readonly text: {
                                    readonly value: string;
                                    readonly start: number;
                                    readonly end: number;
                                };
                                readonly type: "file";
                                readonly path: string;
                            } | {
                                readonly text: {
                                    readonly value: string;
                                    readonly start: number;
                                    readonly end: number;
                                };
                                readonly type: "symbol";
                                readonly path: string;
                                readonly range: {
                                    readonly start: {
                                        readonly line: number;
                                        readonly character: number;
                                    };
                                    readonly end: {
                                        readonly line: number;
                                        readonly character: number;
                                    };
                                };
                                readonly name: string;
                                readonly kind: number;
                            } | {
                                readonly text: {
                                    readonly value: string;
                                    readonly start: number;
                                    readonly end: number;
                                };
                                readonly type: "resource";
                                readonly clientName: string;
                                readonly uri: string;
                            } | undefined;
                        }[] | undefined;
                    } | {
                        readonly status: "error";
                        readonly input: {
                            readonly [x: string]: any;
                        };
                        readonly error: string;
                        readonly metadata?: {
                            readonly [x: string]: any;
                        } | undefined;
                        readonly time: {
                            readonly start: number;
                            readonly end: number;
                        };
                    };
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                };
                readonly time: number;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "message.removed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly messageID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "message.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly info: {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly role: "user";
                    readonly time: {
                        readonly created: number;
                    };
                    readonly format?: {
                        readonly type: "text";
                    } | {
                        readonly type: "json_schema";
                        readonly schema: {
                            readonly [x: string]: any;
                        };
                        readonly retryCount?: number | undefined;
                    } | undefined;
                    readonly summary?: {
                        readonly title?: string | undefined;
                        readonly body?: string | undefined;
                        readonly diffs: readonly {
                            readonly file?: string | undefined;
                            readonly patch?: string | undefined;
                            readonly additions: number;
                            readonly deletions: number;
                            readonly status?: "added" | "deleted" | "modified" | undefined;
                        }[];
                    } | undefined;
                    readonly agent: string;
                    readonly model: {
                        readonly providerID: string;
                        readonly modelID: string;
                        readonly variant?: string | undefined;
                    };
                    readonly system?: string | undefined;
                    readonly tools?: {
                        readonly [x: string]: boolean;
                    } | undefined;
                } | {
                    readonly id: string;
                    readonly sessionID: string;
                    readonly role: "assistant";
                    readonly time: {
                        readonly created: number;
                        readonly completed?: number | undefined;
                    };
                    readonly error?: {
                        readonly name: "APIError";
                        readonly data: {
                            readonly message: string;
                            readonly statusCode?: number | undefined;
                            readonly isRetryable: boolean;
                            readonly responseHeaders?: {
                                readonly [x: string]: string;
                            } | undefined;
                            readonly responseBody?: string | undefined;
                            readonly metadata?: {
                                readonly [x: string]: string;
                            } | undefined;
                        };
                    } | {
                        readonly name: "ProviderAuthError";
                        readonly data: {
                            readonly providerID: string;
                            readonly message: string;
                        };
                    } | {
                        readonly name: "UnknownError";
                        readonly data: {
                            readonly message: string;
                            readonly ref?: string | undefined;
                        };
                    } | {
                        readonly name: "MessageOutputLengthError";
                        readonly data: {};
                    } | {
                        readonly name: "MessageAbortedError";
                        readonly data: {
                            readonly message: string;
                        };
                    } | {
                        readonly name: "StructuredOutputError";
                        readonly data: {
                            readonly message: string;
                            readonly retries: number;
                        };
                    } | {
                        readonly name: "ContextOverflowError";
                        readonly data: {
                            readonly message: string;
                            readonly responseBody?: string | undefined;
                        };
                    } | {
                        readonly name: "ContentFilterError";
                        readonly data: {
                            readonly message: string;
                        };
                    } | undefined;
                    readonly parentID: string;
                    readonly modelID: string;
                    readonly providerID: string;
                    readonly mode: string;
                    readonly agent: string;
                    readonly path: {
                        readonly cwd: string;
                        readonly root: string;
                    };
                    readonly summary?: boolean | undefined;
                    readonly cost: number;
                    readonly tokens: {
                        readonly total?: number | undefined;
                        readonly input: number;
                        readonly output: number;
                        readonly reasoning: number;
                        readonly cache: {
                            readonly read: number;
                            readonly write: number;
                        };
                    };
                    readonly structured?: any;
                    readonly variant?: string | undefined;
                    readonly finish?: string | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.created";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly info: {
                    readonly id: string;
                    readonly slug: string;
                    readonly projectID: string;
                    readonly workspaceID?: string | undefined;
                    readonly directory: string;
                    readonly path?: string | undefined;
                    readonly parentID?: string | undefined;
                    readonly summary?: {
                        readonly additions: number;
                        readonly deletions: number;
                        readonly files: number;
                        readonly diffs?: readonly {
                            readonly file?: string | undefined;
                            readonly patch?: string | undefined;
                            readonly additions: number;
                            readonly deletions: number;
                            readonly status?: "added" | "deleted" | "modified" | undefined;
                        }[] | undefined;
                    } | undefined;
                    readonly cost?: number | undefined;
                    readonly tokens?: {
                        readonly input: number;
                        readonly output: number;
                        readonly reasoning: number;
                        readonly cache: {
                            readonly read: number;
                            readonly write: number;
                        };
                    } | undefined;
                    readonly share?: {
                        readonly url: string;
                    } | undefined;
                    readonly title: string;
                    readonly agent?: string | undefined;
                    readonly model?: {
                        readonly id: string;
                        readonly providerID: string;
                        readonly variant?: string | undefined;
                    } | undefined;
                    readonly version: string;
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                    readonly time: {
                        readonly created: number;
                        readonly updated: number;
                        readonly compacting?: number | undefined;
                        readonly archived?: number | undefined;
                    };
                    readonly permission?: readonly {
                        readonly permission: string;
                        readonly pattern: string;
                        readonly action: "allow" | "ask" | "deny";
                    }[] | undefined;
                    readonly revert?: {
                        readonly messageID: string;
                        readonly partID?: string | undefined;
                        readonly snapshot?: string | undefined;
                        readonly diff?: string | undefined;
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.deleted";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly info: {
                    readonly id: string;
                    readonly slug: string;
                    readonly projectID: string;
                    readonly workspaceID?: string | undefined;
                    readonly directory: string;
                    readonly path?: string | undefined;
                    readonly parentID?: string | undefined;
                    readonly summary?: {
                        readonly additions: number;
                        readonly deletions: number;
                        readonly files: number;
                        readonly diffs?: readonly {
                            readonly file?: string | undefined;
                            readonly patch?: string | undefined;
                            readonly additions: number;
                            readonly deletions: number;
                            readonly status?: "added" | "deleted" | "modified" | undefined;
                        }[] | undefined;
                    } | undefined;
                    readonly cost?: number | undefined;
                    readonly tokens?: {
                        readonly input: number;
                        readonly output: number;
                        readonly reasoning: number;
                        readonly cache: {
                            readonly read: number;
                            readonly write: number;
                        };
                    } | undefined;
                    readonly share?: {
                        readonly url: string;
                    } | undefined;
                    readonly title: string;
                    readonly agent?: string | undefined;
                    readonly model?: {
                        readonly id: string;
                        readonly providerID: string;
                        readonly variant?: string | undefined;
                    } | undefined;
                    readonly version: string;
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                    readonly time: {
                        readonly created: number;
                        readonly updated: number;
                        readonly compacting?: number | undefined;
                        readonly archived?: number | undefined;
                    };
                    readonly permission?: readonly {
                        readonly permission: string;
                        readonly pattern: string;
                        readonly action: "allow" | "ask" | "deny";
                    }[] | undefined;
                    readonly revert?: {
                        readonly messageID: string;
                        readonly partID?: string | undefined;
                        readonly snapshot?: string | undefined;
                        readonly diff?: string | undefined;
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.diff";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly diff: readonly {
                    readonly file?: string | undefined;
                    readonly patch?: string | undefined;
                    readonly additions: number;
                    readonly deletions: number;
                    readonly status?: "added" | "deleted" | "modified" | undefined;
                }[];
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.error";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID?: string | undefined;
                readonly error?: {
                    readonly name: "APIError";
                    readonly data: {
                        readonly message: string;
                        readonly statusCode?: number | undefined;
                        readonly isRetryable: boolean;
                        readonly responseHeaders?: {
                            readonly [x: string]: string;
                        } | undefined;
                        readonly responseBody?: string | undefined;
                        readonly metadata?: {
                            readonly [x: string]: string;
                        } | undefined;
                    };
                } | {
                    readonly name: "ProviderAuthError";
                    readonly data: {
                        readonly providerID: string;
                        readonly message: string;
                    };
                } | {
                    readonly name: "UnknownError";
                    readonly data: {
                        readonly message: string;
                        readonly ref?: string | undefined;
                    };
                } | {
                    readonly name: "MessageOutputLengthError";
                    readonly data: {};
                } | {
                    readonly name: "MessageAbortedError";
                    readonly data: {
                        readonly message: string;
                    };
                } | {
                    readonly name: "StructuredOutputError";
                    readonly data: {
                        readonly message: string;
                        readonly retries: number;
                    };
                } | {
                    readonly name: "ContextOverflowError";
                    readonly data: {
                        readonly message: string;
                        readonly responseBody?: string | undefined;
                    };
                } | {
                    readonly name: "ContentFilterError";
                    readonly data: {
                        readonly message: string;
                    };
                } | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "session.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly info: {
                    readonly id: string;
                    readonly slug: string;
                    readonly projectID: string;
                    readonly workspaceID?: string | undefined;
                    readonly directory: string;
                    readonly path?: string | undefined;
                    readonly parentID?: string | undefined;
                    readonly summary?: {
                        readonly additions: number;
                        readonly deletions: number;
                        readonly files: number;
                        readonly diffs?: readonly {
                            readonly file?: string | undefined;
                            readonly patch?: string | undefined;
                            readonly additions: number;
                            readonly deletions: number;
                            readonly status?: "added" | "deleted" | "modified" | undefined;
                        }[] | undefined;
                    } | undefined;
                    readonly cost?: number | undefined;
                    readonly tokens?: {
                        readonly input: number;
                        readonly output: number;
                        readonly reasoning: number;
                        readonly cache: {
                            readonly read: number;
                            readonly write: number;
                        };
                    } | undefined;
                    readonly share?: {
                        readonly url: string;
                    } | undefined;
                    readonly title: string;
                    readonly agent?: string | undefined;
                    readonly model?: {
                        readonly id: string;
                        readonly providerID: string;
                        readonly variant?: string | undefined;
                    } | undefined;
                    readonly version: string;
                    readonly metadata?: {
                        readonly [x: string]: any;
                    } | undefined;
                    readonly time: {
                        readonly created: number;
                        readonly updated: number;
                        readonly compacting?: number | undefined;
                        readonly archived?: number | undefined;
                    };
                    readonly permission?: readonly {
                        readonly permission: string;
                        readonly pattern: string;
                        readonly action: "allow" | "ask" | "deny";
                    }[] | undefined;
                    readonly revert?: {
                        readonly messageID: string;
                        readonly partID?: string | undefined;
                        readonly snapshot?: string | undefined;
                        readonly diff?: string | undefined;
                    } | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "file.watcher.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly file: string;
                readonly event: "add" | "change" | "unlink";
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "question.v2.asked";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly id: string;
                readonly sessionID: string;
                readonly questions: readonly {
                    readonly question: string;
                    readonly header: string;
                    readonly options: readonly {
                        readonly label: string;
                        readonly description: string;
                    }[];
                    readonly multiple?: boolean | undefined;
                    readonly custom?: boolean | undefined;
                }[];
                readonly tool?: {
                    readonly messageID: string;
                    readonly callID: string;
                } | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "question.v2.rejected";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly requestID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "question.v2.replied";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly requestID: string;
                readonly answers: readonly (readonly string[])[];
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "todo.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly todos: readonly {
                    readonly content: string;
                    readonly status: string;
                    readonly priority: string;
                }[];
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "models-dev.refreshed";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {};
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "integration.connection.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly integrationID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "integration.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {};
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "catalog.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {};
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "file.edited";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly file: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "reference.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {};
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "permission.v2.asked";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly action: string;
                readonly resources: readonly string[];
                readonly save?: readonly string[] | undefined;
                readonly metadata?: {
                    readonly [x: string]: unknown;
                } | undefined;
                readonly source?: {
                    readonly type: "tool";
                    readonly messageID: string;
                    readonly callID: string;
                } | undefined;
                readonly id: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "permission.v2.replied";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly sessionID: string;
                readonly requestID: string;
                readonly reply: "always" | "once" | "reject";
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "plugin.added";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly id: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "project.directories.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly projectID: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "pty.created";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly info: {
                    readonly id: string;
                    readonly title: string;
                    readonly command: string;
                    readonly args: readonly string[];
                    readonly cwd: string;
                    readonly status: "exited" | "running";
                    readonly pid: number;
                    readonly exitCode?: number | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "pty.deleted";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly id: string;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "pty.exited";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly id: string;
                readonly exitCode: number;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "pty.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly info: {
                    readonly id: string;
                    readonly title: string;
                    readonly command: string;
                    readonly args: readonly string[];
                    readonly cwd: string;
                    readonly status: "exited" | "running";
                    readonly pid: number;
                    readonly exitCode?: number | undefined;
                };
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "scheduled.task.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {
                readonly task: {
                    readonly id: string;
                    readonly name: string;
                    readonly projectID: string;
                    readonly location: {
                        readonly directory: string;
                        readonly workspaceID?: string | undefined;
                    };
                    readonly prompt: {
                        readonly text: string;
                        readonly files?: readonly {
                            readonly uri: string;
                            readonly mime: string;
                            readonly name?: string | undefined;
                            readonly description?: string | undefined;
                            readonly source?: {
                                readonly start: number;
                                readonly end: number;
                                readonly text: string;
                            } | undefined;
                        }[] | undefined;
                        readonly agents?: readonly {
                            readonly name: string;
                            readonly source?: {
                                readonly start: number;
                                readonly end: number;
                                readonly text: string;
                            } | undefined;
                        }[] | undefined;
                    };
                    readonly schedule: "daily" | "once";
                    readonly timezone: string;
                    readonly runAt: number;
                    readonly model: {
                        readonly id: string;
                        readonly providerID: string;
                        readonly variant?: string | undefined;
                    };
                    readonly effort?: "high" | "low" | "medium" | "xhigh" | undefined;
                    readonly approvalMode: "ask" | "auto" | "plan";
                    readonly enabled: boolean;
                    readonly revision: number;
                    readonly nextRun?: number | undefined;
                    readonly lastRun?: number | undefined;
                };
                readonly run?: {
                    readonly id: string;
                    readonly taskId: string;
                    readonly scheduledAt: number;
                    readonly revision: number;
                    readonly status: "completed" | "failed" | "interrupted" | "missed" | "pending" | "running";
                    readonly sessionId?: string | undefined;
                    readonly promptMessageId?: string | undefined;
                    readonly startedAt?: number | undefined;
                    readonly endedAt?: number | undefined;
                    readonly error?: {
                        readonly code: "KEY_MISSING" | "KEY_REJECTED" | "MODEL_UNAVAILABLE" | "MODEL_VENDOR_CONFLICT" | "MODEL_VENDOR_MISMATCH" | "PROJECT_INVALID" | "PROVIDER_DISABLED" | "REQUEST_CONFLICT" | "REVISION_CONFLICT" | "SECRET_STORE_UNAVAILABLE" | "UPSTREAM_INVALID_RESPONSE" | "UPSTREAM_RATE_LIMITED" | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNREACHABLE";
                        readonly retryable: boolean;
                        readonly requestId: string;
                        readonly details?: string | undefined;
                    } | undefined;
                } | undefined;
            };
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly type: "relay.catalog.updated";
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly data: {};
        } | {
            readonly id: string;
            readonly metadata?: {
                readonly [x: string]: unknown;
            } | undefined;
            readonly durable?: {
                readonly aggregateID: string;
                readonly seq: number;
                readonly version: number;
            } | undefined;
            readonly location?: {
                readonly directory: string;
                readonly workspaceID?: string | undefined;
            } | undefined;
            readonly type: "server.connected";
            readonly data: {};
        }>;
    };
    ptys: {
        list: (input?: PtysListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<PtysListOutput>;
        create: (input?: PtysCreateInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<PtysCreateOutput>;
        get: (input: PtysGetInput, requestOptions?: RequestOptions | undefined) => Promise<PtysGetOutput>;
        update: (input: PtysUpdateInput, requestOptions?: RequestOptions | undefined) => Promise<PtysUpdateOutput>;
        remove: (input: PtysRemoveInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
    questions: {
        listRequests: (input?: QuestionsListRequestsInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<QuestionsListRequestsOutput>;
        list: (input: QuestionsListInput, requestOptions?: RequestOptions | undefined) => Promise<readonly {
            readonly id: string;
            readonly sessionID: string;
            readonly questions: readonly {
                readonly question: string;
                readonly header: string;
                readonly options: readonly {
                    readonly label: string;
                    readonly description: string;
                }[];
                readonly multiple?: boolean | undefined;
                readonly custom?: boolean | undefined;
            }[];
            readonly tool?: {
                readonly messageID: string;
                readonly callID: string;
            } | undefined;
        }[]>;
        reply: (input: QuestionsReplyInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        reject: (input: QuestionsRejectInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
    references: {
        list: (input?: ReferencesListInput | undefined, requestOptions?: RequestOptions | undefined) => Promise<ReferencesListOutput>;
    };
    projectCopies: {
        create: (input: ProjectCopiesCreateInput, requestOptions?: RequestOptions | undefined) => Promise<ProjectCopiesCreateOutput>;
        remove: (input: ProjectCopiesRemoveInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
        refresh: (input: ProjectCopiesRefreshInput, requestOptions?: RequestOptions | undefined) => Promise<void>;
    };
};
