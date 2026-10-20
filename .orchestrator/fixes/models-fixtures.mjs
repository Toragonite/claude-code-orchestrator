// models-fixtures.mjs — three REAL result documents of `claude -p --model <alias> --output-format json`,
// captured on Claude Code 2.1.283 (2026-10-14), one per tier alias. They are what
// .orchestrator/fixes/models.mjs reads the reported model from, and what its fake `claude`
// (models-fake-claude.mjs) prints for a run on that alias.
//
// Verbatim except that `session_id` and `uuid` are removed (they identify a session of the
// account that was probed, and nothing here reads them). No token, e-mail or path is in a result
// document.
//
// What they show, and what the product relies on: `modelUsage` is keyed by the FULL id of every
// model the run called; a run on any alias but haiku also lists a small `claude-haiku-…` helper
// entry, so the main model is the entry that cost the most.

/** alias → the id that alias resolved to on the probed CLI. */
export const RESOLVED = {
  "haiku": "claude-haiku-4-5-20251001",
  "sonnet": "claude-sonnet-5",
  "opus": "claude-opus-5-5"
};

/** alias → the result document of that run. */
export const RESULT_DOCUMENTS = {
  "haiku": {
    "duration_api_ms": 2193,
    "stop_reason": "end_turn",
    "total_cost_usd": 0.0329386,
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 15206,
      "cache_read_input_tokens": 13696,
      "output_tokens": 38,
      "output_tokens_details": {
        "thinking_tokens": 31
      },
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 15206,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": "not_available",
      "iterations": [
        {
          "input_tokens": 10,
          "output_tokens": 38,
          "cache_read_input_tokens": 13696,
          "cache_creation_input_tokens": 15206,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 15206
          },
          "type": "message"
        }
      ],
      "speed": "standard"
    },
    "modelUsage": {
      "claude-haiku-4-5-20251001": {
        "inputTokens": 907,
        "outputTokens": 50,
        "cacheReadInputTokens": 13696,
        "cacheCreationInputTokens": 15206,
        "webSearchRequests": 0,
        "costUSD": 0.0329386,
        "contextWindow": 200000,
        "maxOutputTokens": 32000,
        "thinkingTokens": 31,
        "canonicalModel": "claude-haiku-4-5",
        "provider": "firstParty",
        "costBasis": "list"
      }
    },
    "permission_denials": [],
    "terminal_reason": "completed",
    "fast_mode_state": "off",
    "fast_mode_disabled_reason": "sdk_opt_in_required",
    "subagent_stats": {
      "spawned": 0,
      "requested": {
        "background": 0,
        "foreground": 0,
        "unset": 0
      },
      "started_in_background": 0,
      "max_depth": 0,
      "spawned_by_subagents": 0,
      "completed": 0,
      "failed": 0,
      "killed": {
        "parent": 0,
        "user": 0,
        "system": 0
      },
      "refused": {
        "depth_limit": 0,
        "concurrency_limit": 0,
        "budget": 0
      },
      "by_type": {}
    },
    "is_error": false,
    "num_turns": 1,
    "subtype": "success",
    "api_error_status": null,
    "result": "OK",
    "ttft_ms": 2045,
    "type": "result",
    "duration_ms": 2907,
    "ttft_stream_ms": 1740,
    "time_to_request_ms": 663,
    "first_content_frame_ms": 1740,
    "queued_turn_count": 0,
    "result_index": 0
  },
  "sonnet": {
    "duration_api_ms": 2865,
    "stop_reason": "end_turn",
    "total_cost_usd": 0.186963,
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 46493,
      "cache_read_input_tokens": 0,
      "output_tokens": 4,
      "output_tokens_details": {
        "thinking_tokens": 0
      },
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 46493,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": "global",
      "iterations": [
        {
          "input_tokens": 2,
          "output_tokens": 4,
          "cache_read_input_tokens": 0,
          "cache_creation_input_tokens": 46493,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 46493
          },
          "type": "message"
        }
      ],
      "speed": "standard"
    },
    "modelUsage": {
      "claude-haiku-4-5-20251001": {
        "inputTokens": 897,
        "outputTokens": 10,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0,
        "webSearchRequests": 0,
        "costUSD": 0.000947,
        "contextWindow": 200000,
        "maxOutputTokens": 32000,
        "thinkingTokens": 0,
        "canonicalModel": "claude-haiku-4-5",
        "provider": "firstParty",
        "costBasis": "list"
      },
      "claude-sonnet-5": {
        "inputTokens": 2,
        "outputTokens": 4,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 46493,
        "webSearchRequests": 0,
        "costUSD": 0.186016,
        "contextWindow": 1000000,
        "maxOutputTokens": 64000,
        "thinkingTokens": 0,
        "canonicalModel": "claude-sonnet-5",
        "provider": "firstParty",
        "costBasis": "list"
      }
    },
    "permission_denials": [],
    "terminal_reason": "completed",
    "fast_mode_state": "off",
    "fast_mode_disabled_reason": "sdk_opt_in_required",
    "subagent_stats": {
      "spawned": 0,
      "requested": {
        "background": 0,
        "foreground": 0,
        "unset": 0
      },
      "started_in_background": 0,
      "max_depth": 0,
      "spawned_by_subagents": 0,
      "completed": 0,
      "failed": 0,
      "killed": {
        "parent": 0,
        "user": 0,
        "system": 0
      },
      "refused": {
        "depth_limit": 0,
        "concurrency_limit": 0,
        "budget": 0
      },
      "by_type": {}
    },
    "is_error": false,
    "num_turns": 1,
    "subtype": "success",
    "api_error_status": null,
    "result": "OK",
    "ttft_ms": 2840,
    "type": "result",
    "duration_ms": 3359,
    "ttft_stream_ms": 2281,
    "time_to_request_ms": 744,
    "first_content_frame_ms": 2282,
    "queued_turn_count": 0,
    "result_index": 0
  },
  "opus": {
    "duration_api_ms": 3041,
    "stop_reason": "end_turn",
    "total_cost_usd": 0.2083642,
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 25651,
      "cache_read_input_tokens": 10631,
      "output_tokens": 4,
      "output_tokens_details": {
        "thinking_tokens": 0
      },
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 25651,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": "global",
      "iterations": [
        {
          "input_tokens": 2,
          "output_tokens": 4,
          "cache_read_input_tokens": 10631,
          "cache_creation_input_tokens": 25651,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 25651
          },
          "type": "message"
        }
      ],
      "speed": "standard"
    },
    "modelUsage": {
      "claude-haiku-4-5-20251001": {
        "inputTokens": 897,
        "outputTokens": 9,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0,
        "webSearchRequests": 0,
        "costUSD": 0.000942,
        "contextWindow": 200000,
        "maxOutputTokens": 32000,
        "thinkingTokens": 0,
        "canonicalModel": "claude-haiku-4-5",
        "provider": "firstParty",
        "costBasis": "list"
      },
      "claude-opus-5-5": {
        "inputTokens": 2,
        "outputTokens": 4,
        "cacheReadInputTokens": 10631,
        "cacheCreationInputTokens": 25651,
        "webSearchRequests": 0,
        "costUSD": 0.2074222,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000,
        "thinkingTokens": 0,
        "canonicalModel": "claude-opus-5-5",
        "provider": "firstParty",
        "costBasis": "list"
      }
    },
    "permission_denials": [],
    "terminal_reason": "completed",
    "fast_mode_state": "off",
    "fast_mode_disabled_reason": "sdk_opt_in_required",
    "subagent_stats": {
      "spawned": 0,
      "requested": {
        "background": 0,
        "foreground": 0,
        "unset": 0
      },
      "started_in_background": 0,
      "max_depth": 0,
      "spawned_by_subagents": 0,
      "completed": 0,
      "failed": 0,
      "killed": {
        "parent": 0,
        "user": 0,
        "system": 0
      },
      "refused": {
        "depth_limit": 0,
        "concurrency_limit": 0,
        "budget": 0
      },
      "by_type": {}
    },
    "is_error": false,
    "num_turns": 1,
    "subtype": "success",
    "api_error_status": null,
    "result": "OK",
    "ttft_ms": 1962,
    "type": "result",
    "duration_ms": 2676,
    "ttft_stream_ms": 1957,
    "time_to_request_ms": 998,
    "first_content_frame_ms": 1958,
    "queued_turn_count": 0,
    "result_index": 0
  }
};
