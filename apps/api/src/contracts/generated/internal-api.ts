/* eslint-disable */
// GENERATED from docs/contracts by scripts/gen-contract-types.ts. Do not edit.

export interface paths {
    "/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a new call and get the agent config snapshot (called by Voice Gateway) */
        post: operations["startCall"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/calls/{call_id}/transfer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve the human handoff target for this call */
        post: operations["transferToHuman"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contacts/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["lookupContact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["checkAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/appointments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAppointments"];
        put?: never;
        post: operations["bookAppointment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/appointments/{appointment_id}/reschedule": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rescheduleAppointment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/appointments/{appointment_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelAppointment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["searchKnowledge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Phone: string;
        /** @enum {string} */
        Language: "en-IN" | "hi-IN";
        Contact: {
            /** Format: uuid */
            contact_id: string;
            phone: components["schemas"]["Phone"];
            name?: string | null;
            language?: components["schemas"]["Language"];
            consent_outbound?: boolean;
        };
        Slot: {
            /** Format: uuid */
            slot_id: string;
            /** Format: uuid */
            provider_id: string;
            provider_name: string;
            /** Format: uuid */
            location_id?: string;
            location_name?: string;
            /** Format: date-time */
            start: string;
            /** Format: date-time */
            end: string;
            /** @description Pre-formatted for TTS in the location timezone, e.g. "Friday 24 October at 4:30 PM" */
            speakable?: string;
        };
        Appointment: {
            /** Format: uuid */
            appointment_id: string;
            /** @enum {string} */
            status: "booked" | "rescheduled" | "cancelled" | "completed" | "no_show";
            /** Format: uuid */
            contact_id?: string;
            slot: components["schemas"]["Slot"];
            /** @enum {string} */
            source?: "call" | "dashboard" | "import";
        };
        Error: {
            error: {
                /** @enum {string} */
                code: "VALIDATION_ERROR" | "UNAUTHORIZED" | "TENANT_MISMATCH" | "NOT_FOUND" | "SLOT_TAKEN" | "OUTSIDE_HOURS" | "POLICY_BLOCKED" | "INTERNAL";
                message: string;
                details?: {
                    alternatives?: components["schemas"]["Slot"][];
                };
            };
        };
        /** @enum {string} */
        language: "en-IN" | "hi-IN";
        /** @description Text per language */
        localized: {
            [key: string]: string;
        };
        /** @description List of strings per language */
        localizedList: {
            [key: string]: string[];
        };
        /**
         * Agent config (v1)
         * @description Immutable snapshot of one agent version. Returned by POST /internal/v1/calls; the Voice Worker uses it for the whole call.
         */
        "agent-config.v1.schema": {
            /** Format: uuid */
            agent_id: string;
            version: number;
            /** Format: uuid */
            tenant_id: string;
            /** @description Name the agent introduces itself with */
            name?: string;
            /** @example clinic-receptionist@1 */
            template: string;
            /** @example Asia/Kolkata */
            timezone: string;
            languages: {
                primary: components["schemas"]["language"];
                supported: components["schemas"]["language"][];
                /**
                 * @description Follow the caller's language turn by turn (Hinglish)
                 * @default true
                 */
                auto_switch: boolean;
            };
            greeting: components["schemas"]["localized"];
            ai_disclosure: {
                /** @constant */
                enabled: true;
                text: components["schemas"]["localized"];
            };
            /** @description Rendered prompt from the template plus tenant variables */
            system_prompt: string;
            /** @description Tenant values the prompt was rendered with (clinic name, address, fees...) */
            variables?: {
                [key: string]: unknown;
            };
            voice: {
                /** @enum {string} */
                provider: "sarvam" | "elevenlabs";
                voice_ids: components["schemas"]["localized"];
                /** @default 1 */
                speed: number;
            };
            stt: {
                /** @enum {string} */
                provider: "sarvam" | "deepgram";
                model?: string;
                /** @description Doctor names, clinic terms to boost */
                keywords?: string[];
            };
            llm: {
                provider: string;
                model: string;
                /** @default 0.3 */
                temperature: number;
                /** @default 250 */
                max_output_tokens: number;
            };
            tools: ("lookup_contact" | "check_availability" | "book_appointment" | "list_appointments" | "reschedule_appointment" | "cancel_appointment" | "search_knowledge" | "transfer_to_human" | "end_call")[];
            knowledge_base_ids?: string[];
            handoff: {
                enabled: boolean;
                /** @default true */
                on_caller_request: boolean;
                /** @default 2 */
                after_failed_turns: number;
                unavailable_message?: components["schemas"]["localized"];
            };
            safety: {
                forbid_medical_advice: boolean;
                emergency: {
                    keywords: components["schemas"]["localizedList"];
                    script: components["schemas"]["localized"];
                    /** @enum {string} */
                    action: "transfer" | "script_then_end";
                };
            };
            limits: {
                /** @default 600 */
                max_duration_sec: number;
                /** @default 8 */
                silence_timeout_sec: number;
                /** @default 2 */
                max_reprompts: number;
                /** @default 2000 */
                tool_timeout_ms: number;
                /** @default 1000 */
                filler_after_ms: number;
            };
            recording?: {
                /** @default true */
                enabled: boolean;
                /** @default 90 */
                retention_days: number;
            };
            post_call?: {
                /** @default true */
                whatsapp_confirmation: boolean;
            };
            $defs: {
                /** @enum {string} */
                language: "en-IN" | "hi-IN";
                /** @description Text per language */
                localized: {
                    [key: string]: string;
                };
                /** @description List of strings per language */
                localizedList: {
                    [key: string]: string[];
                };
            };
        };
    };
    responses: {
        /** @description Error */
        Error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        TenantHeader: string;
        CallIdHeader: string;
        IdempotencyKey: string;
        CallId: string;
        AppointmentId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    startCall: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    provider: "exotel" | "plivo";
                    provider_call_id: string;
                    /** @enum {string} */
                    direction: "inbound" | "outbound";
                    from: components["schemas"]["Phone"];
                    to: components["schemas"]["Phone"];
                    /** Format: uuid */
                    campaign_id?: string | null;
                };
            };
        };
        responses: {
            /** @description Call registered */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        call_id: string;
                        /** Format: uuid */
                        tenant_id: string;
                        agent: components["schemas"]["agent-config.v1.schema"];
                        contact?: components["schemas"]["Contact"] | null;
                    };
                };
            };
            404: components["responses"]["Error"];
        };
    };
    transferToHuman: {
        parameters: {
            query?: never;
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                call_id: components["parameters"]["CallId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    reason: "caller_request" | "emergency" | "agent_confused" | "policy" | "error";
                    /** @description One-line context for staff */
                    summary?: string;
                };
            };
        };
        responses: {
            /** @description Transfer target */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        target_phone: components["schemas"]["Phone"];
                        /** @description False outside staffed hours */
                        available: boolean;
                        fallback_message?: string;
                    };
                };
            };
        };
    };
    lookupContact: {
        parameters: {
            query: {
                phone: components["schemas"]["Phone"];
            };
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Contact with upcoming appointments, or null */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contact?: components["schemas"]["Contact"] | null;
                        upcoming?: components["schemas"]["Appointment"][];
                    };
                };
            };
        };
    };
    checkAvailability: {
        parameters: {
            query: {
                provider_id?: string;
                specialty?: string;
                location_id?: string;
                from: string;
                to: string;
                limit?: number;
            };
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Open slots, soonest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        slots: components["schemas"]["Slot"][];
                    };
                };
            };
            422: components["responses"]["Error"];
        };
    };
    listAppointments: {
        parameters: {
            query: {
                contact_id: string;
                status?: "upcoming" | "past" | "all";
            };
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Appointments */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        appointments?: components["schemas"]["Appointment"][];
                    };
                };
            };
        };
    };
    bookAppointment: {
        parameters: {
            query?: never;
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    slot_id: string;
                    /** @description Existing contact_id, or phone + name to create one */
                    contact: {
                        /** Format: uuid */
                        contact_id?: string;
                        phone?: components["schemas"]["Phone"];
                        name?: string;
                        language?: components["schemas"]["Language"];
                    };
                    /** @description Caller's stated reason */
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Booked */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Appointment"];
                };
            };
            409: components["responses"]["Error"];
        };
    };
    rescheduleAppointment: {
        parameters: {
            query?: never;
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                appointment_id: components["parameters"]["AppointmentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    new_slot_id: string;
                };
            };
        };
        responses: {
            /** @description Rescheduled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Appointment"];
                };
            };
            409: components["responses"]["Error"];
        };
    };
    cancelAppointment: {
        parameters: {
            query?: never;
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                appointment_id: components["parameters"]["AppointmentId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Cancelled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Appointment"];
                };
            };
            422: components["responses"]["Error"];
        };
    };
    searchKnowledge: {
        parameters: {
            query?: never;
            header: {
                "X-Tenant-Id": components["parameters"]["TenantHeader"];
                "X-Call-Id": components["parameters"]["CallIdHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    query: string;
                    language?: components["schemas"]["Language"];
                    /** @default 3 */
                    top_k?: number;
                };
            };
        };
        responses: {
            /** @description Relevant chunks from the tenant's knowledge base */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results?: {
                            /** Format: uuid */
                            doc_id: string;
                            title?: string;
                            text: string;
                            score: number;
                        }[];
                    };
                };
            };
        };
    };
}
