// Data only: config.ts imports this file at run time, so it may import only
// types, or an import cycle appears.
import type { ProviderConfig } from './config'

// The providers that ship with the app. They are the same JSON a user can add
// as a custom provider. To add a built-in, add a literal here: it needs no
// type union, no Rust change, and no per-provider module. Built-ins skip the
// schema at run time, so every field the schema would fill in is written out
// here (config.test.ts checks this).
export const BUILT_IN_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    // Without it, /models lists only the models that write text.
    modelListQuery: { output_modalities: 'all' },
    modelImageInput: { path: 'architecture.input_modalities' },
    // A list of request fields that the model takes; it holds "tools" for a
    // model that calls tools, and "reasoning" for one that takes the
    // `reasoning` field of `thinking` below.
    modelToolCalling: { path: 'supported_parameters' },
    modelThinking: { path: 'supported_parameters' },
    // A list; "text" with "image" is a chat model that also makes images
    // (`imageOutputBody`). Image-only models answer only through
    // OpenRouter's Image API (their `endpoints` have no chat route, only
    // `/api/v1/images`), so they take the media API (`mediaApi`). "image"
    // counts only with an image price: the routers (`openrouter/auto`)
    // report it too, but none of their models makes images (checked live,
    // 2026-11-10); each of the 55 image-only models has the price (checked
    // live, 2026-11-11).
    // Speech and video-only models take the media API too. No
    // field tells that a video model needs an image, so each one has the
    // kind `video`, and the image of a message goes as a frame to a model
    // that takes frames (the video list, mediaFormats.ts). The few models
    // that need a video get the same request, and OpenRouter refuses it.
    // "audio" comes only with "text": those models answer through chat,
    // with audio only when the request asks for it (`audioOutputs`).
    // "transcription" models write down the speech of an audio clip.
    modelOutputs: {
      path: 'architecture.output_modalities',
      values: {
        text: { outputs: ['text'], request: 'chat' },
        image: { outputs: ['image'], request: 'image', requiredPath: 'pricing.image_output' },
        audio: { outputs: ['audio'] },
        speech: { outputs: ['audio'], request: 'tts' },
        video: { outputs: ['video'], request: 'video' },
        transcription: { outputs: ['text'], request: 'transcription' },
        embeddings: { outputs: [] },
        rerank: { outputs: [] },
        decisions: { outputs: [] },
      },
    },
    // The day that OpenRouter added the model, not always its release
    // (Unix seconds; checked live, 2026-11-12).
    modelReleased: { path: 'created', format: 'unixSeconds' },
    // Texts of USD per token; `-1` for a router model (`openrouter/auto`),
    // whose price is that of the model that it picks. `overrides`: other
    // rates by prompt length or time (checked live, 2026-11-14). The music
    // models (Lyria) have "0" for their tokens and no audio price: their
    // price per clip is only in their description (checked live,
    // 2026-11-14), so Dez knows none (modelPrices.ts).
    // `input_cache_write` is the rate of a 5-minute cache write; a write
    // that lives an hour has its own rate (`input_cache_write_1h`), which
    // no request of Dez asks for (checked live, 2026-11-14).
    // https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
    modelTokenPrices: {
      input: 'pricing.prompt',
      output: 'pricing.completion',
      cachedInput: 'pricing.input_cache_read',
      cacheWrite: 'pricing.input_cache_write',
      perTokens: 1,
      otherRates: 'pricing.overrides',
      imageOutput: 'pricing.image_output',
      audioOutput: 'pricing.audio_output',
    },
    // `context_length` is the window of the model, and
    // `top_provider.context_length` that of the provider that OpenRouter
    // picks first, which is less for some models. No doc tells that a
    // long prompt goes to a provider with the larger window, so the
    // smaller number counts. Most speech, video, and transcription models
    // have 0, and some models have a null number of the first provider:
    // no number (checked live, 2026-11-14).
    // https://openrouter.ai/docs/guides/overview/models
    modelContextWindow: { paths: ['context_length', 'top_provider.context_length'] },
    auth: 'apiKey',
    // OpenRouter passes the marks on to the models that cache only a marked
    // prompt (Claude, Gemini, Qwen), and makes OpenAI's own marks of them for
    // GPT-5.6 and later.
    // https://openrouter.ai/docs/guides/best-practices/prompt-caching
    cacheBreakpoints: true,
    // Unlike other fields, OpenRouter does not drop this one for a model
    // that cannot make images: it answers 404 "No endpoints found that
    // support the requested output modalities" (checked live with
    // `openrouter/auto`, 2026-11-10). So it goes only to the models whose
    // outputs hold `image`. The streamed images are in `delta.images`.
    // https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
    imageOutputBody: { modalities: ['image', 'text'] },
    // The models that answer with audio (outputs "text" and "audio"). The
    // OpenAI voice models need a voice, and while they stream they give
    // only `pcm16`: raw 16-bit PCM, 24 kHz, one channel ("does not support
    // 'mp3' when stream=true. Supported values are: 'pcm16'"). The music
    // models (Lyria) give a whole mp3 file. Checked live, 2026-11-14.
    // https://openrouter.ai/docs/guides/overview/multimodal/audio
    // https://developers.openai.com/api/docs/guides/audio-chat-completions
    audioOutputs: [
      {
        modelIdPrefix: 'openai/gpt-audio',
        body: { modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'pcm16' } },
        contentType: 'audio/pcm;rate=24000',
        pcmSampleBits: 16,
      },
      { modelIdPrefix: 'google/lyria-', body: { modalities: ['text', 'audio'], audio: { format: 'mp3' } }, contentType: 'audio/mpeg' },
    ],
    // The image-only, speech, and video models take OpenRouter's own image,
    // speech, and video APIs. A speech request asks for mp3. "HeyGen Voice
    // and Gemini TTS only return `pcm` [...]; these return a 400 for the
    // other format", and no field of a model entry tells it, so these parts
    // do. Dez makes a WAV file of the raw PCM (pcmAudio.ts).
    // https://openrouter.ai/docs/guides/overview/multimodal/tts
    mediaApi: {
      format: 'openrouter',
      modelRequestBodies: [
        { request: 'tts', modelIdPrefix: 'heygen/', body: { response_format: 'pcm' } },
        { request: 'tts', modelIdPrefix: 'google/gemini-', body: { response_format: 'pcm' } },
      ],
    },
    // OpenRouter drops a field that the routed model does not take, so the
    // request is safe for every model. Some models must think, so there is no
    // off field. A model whose `supported_parameters` has no "reasoning"
    // gets no field and no Thinking toggle (`modelThinking`).
    thinking: { enabledBody: { reasoning: { enabled: true } } },
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiFormat: 'openai',
    // Z.ai's /models reports ids only; these give the known models names
    // and windows. The windows are those of Z.ai's model pages and of its
    // coding plan guide: "`glm-5.2` is `1000000`; other models `200000`"
    // (checked 2026-11-14).
    // https://docs.z.ai/guides/overview/overview
    // https://docs.z.ai/devpack/tool/others
    // https://docs.z.ai/guides/llm/glm-4.5
    models: [
      { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 1_000_000 },
      { id: 'glm-5.1', name: 'GLM 5.1', contextWindow: 200_000 },
      { id: 'glm-5', name: 'GLM 5', contextWindow: 200_000 },
      { id: 'glm-5-turbo', name: 'GLM 5 Turbo', contextWindow: 200_000 },
      { id: 'glm-4.7', name: 'GLM 4.7', contextWindow: 200_000 },
      { id: 'glm-4.6', name: 'GLM 4.6', contextWindow: 200_000 },
      { id: 'glm-4.5', name: 'GLM 4.5', contextWindow: 128_000 },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // GLM-5.3 refuses `type: 'disabled'`, so there is no off field.
    thinking: { enabledBody: { thinking: { type: 'enabled' } } },
  },
  {
    id: 'venice',
    name: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    // Without it, /models lists only the text models.
    modelListQuery: { type: 'all' },
    modelImageInput: { path: 'model_spec.capabilities.supportsVision' },
    modelToolCalling: { path: 'model_spec.capabilities.supportsFunctionCalling' },
    modelThinking: { path: 'model_spec.capabilities.supportsReasoning' },
    modelReadableName: { path: 'model_spec.name' },
    // "Release date on Venice API": the day that Venice added the model, at
    // midnight UTC (Unix seconds; checked live, 2026-11-12).
    modelReleased: { path: 'created', format: 'unixSeconds' },
    // `{ usd, diem }` objects per 1M tokens. Some models have `cache_write`,
    // the rate of a 5-minute cache write, and for some of them it is under
    // the input rate (chatRequestCost has the floor). `extended`: the rates
    // of a prompt over `context_token_threshold` tokens (checked live,
    // 2026-11-14).
    modelTokenPrices: {
      input: 'model_spec.pricing.input.usd',
      output: 'model_spec.pricing.output.usd',
      cachedInput: 'model_spec.pricing.cache_input.usd',
      cacheWrite: 'model_spec.pricing.cache_write.usd',
      perTokens: 1_000_000,
      otherRates: 'model_spec.pricing.extended',
    },
    // The window of a text model, and the most images that Venice states
    // for a model that reads images ("Check ... `maxImages` under
    // `model_spec.capabilities` ... before sending several"). That count
    // is a limit of one message, not of a request: a request with 11
    // images in one message gets HTTP 400 ("At most 10 image(s) may be
    // provided in one request."), one with 6 and 5 images in two messages
    // passes, and so does one with 12 images in several messages (Claude
    // models; checked live, 2026-11-14).
    // https://docs.venice.ai/guides/features/vision
    modelContextWindow: { paths: ['model_spec.availableContextTokens'] },
    modelMessageImageLimit: { paths: ['model_spec.capabilities.maxImages'] },
    // One `type` per model. `inpaint` models edit images, and `upscale`
    // models make an image larger. `music` models also make sounds and
    // speech; one of them is a voice changer (`model_spec.voice_changer`),
    // which says the speech of an audio clip in another voice. Every video
    // model has the type `video`, and `model_spec.constraints.model_type`
    // tells what it needs: just a text (`text-to-video`), an image
    // (`image-to-video`), or a video (`video`: an edit, a motion control,
    // an extension, an upscale). `asr` models write down the speech of an
    // audio clip.
    modelOutputs: {
      path: 'type',
      values: {
        text: { outputs: ['text'], request: 'chat' },
        image: { outputs: ['image'], request: 'image' },
        inpaint: { outputs: ['image'], request: 'imageEdit' },
        upscale: { outputs: ['image'], request: 'upscale' },
        tts: { outputs: ['audio'], request: 'tts' },
        music: {
          outputs: ['audio'],
          request: 'music',
          requestBy: { path: 'model_spec.voice_changer', values: { true: 'voiceChange' } },
        },
        video: {
          outputs: ['video'],
          requestBy: {
            path: 'model_spec.constraints.model_type',
            values: { 'text-to-video': 'video', 'image-to-video': 'imageToVideo', video: 'videoToVideo' },
          },
        },
        asr: { outputs: ['text'], request: 'transcription' },
        embedding: { outputs: [] },
        decision: { outputs: [] },
      },
    },
    auth: 'apiKey',
    // The Venice docs say that Venice adds the marks for Claude. A live check
    // (2026-11-14, Claude Haiku 5.5) found two marks of Venice: at the end of
    // the system prompt, and on the message before the last user message.
    // They do not store the newest messages, and an older live check got no
    // Claude cache hits without Dez's marks, so Dez sets its own. Venice's
    // other models take the marks with no error (also checked live).
    cacheBreakpoints: true,
    // A live check with Claude Haiku 5.5: a mark on a tool message's text
    // part stored nothing, a mark on the message stored the prompt up to it.
    // Its other models took the message mark with no error.
    toolMessageCacheMark: 'message',
    // In a live check, Qwen3-VL cached nothing without it.
    // https://docs.venice.ai/guides/features/prompt-caching
    promptCacheKey: true,
    // Venice adds its own system prompt when this field is missing, so every
    // request turns it off.
    requestBody: { venice_parameters: { include_venice_system_prompt: false } },
    // The image, speech, music, and video models take Venice's own media
    // API.
    mediaApi: { format: 'venice' },
    // A chat request sends these `venice_parameters` too, with these defaults
    // when the user has not changed a toggle in the provider settings popup.
    // Each text model's `model_spec.capabilities` tells which searches it
    // takes (`modelSupport`).
    settings: [
      {
        key: 'webSearch',
        label: 'Web search',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_web_search',
        // Venice takes a string here ('auto' | 'on' | 'off'); the other flags
        // are booleans.
        onValue: 'on',
        offValue: 'off',
        modelSupport: { path: 'model_spec.capabilities.supportsWebSearch' },
      },
      {
        key: 'xSearch',
        label: 'X search',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_x_search',
        // X search applies only to Grok models, and every Grok model id
        // Venice serves starts with `grok-` (e.g. grok-4-20). The prefix
        // is the rule for a model that the model cache does not have yet;
        // the flag of the list then leaves out a Grok model with no X
        // search (`grok-build-0-1`, 2026-11-10).
        modelIdPrefix: 'grok-',
        modelSupport: { path: 'model_spec.capabilities.supportsXSearch' },
      },
      {
        key: 'webScraping',
        label: 'Web scraping',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_web_scraping',
      },
    ],
    // Venice's own off switch, which also removes the thinking from replies.
    thinking: {
      enabledBody: { reasoning: { enabled: true } },
      disabledBody: { venice_parameters: { disable_thinking: true } },
    },
  },
  {
    id: 'charm_hyper',
    name: 'Charm Hyper',
    baseUrl: 'https://hyper.charm.land/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
    // Hyper's models think by default, and their effort levels differ per
    // model, so no field is sent.
    thinking: {},
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiFormat: 'anthropic',
    // No window: MiniMax's docs state none for the M2 models (checked
    // 2026-11-14).
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1' },
      { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed' },
      { id: 'MiniMax-M2', name: 'MiniMax M2' },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // MiniMax recommends 65536 output tokens for these models.
    maxOutputTokens: 65536,
    // M3 on this endpoint thinks only with `adaptive`, and M3.1-Flash refuses
    // `disabled`, so there is no off field.
    thinking: { enabledBody: { thinking: { type: 'adaptive' } } },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding',
    apiFormat: 'anthropic',
    // The window of these models is "up to 1048576 (for higher-tier
    // members)", and a lower plan "only supports up to 256K context". Dez
    // does not know the plan of the key, so the smaller window counts
    // (checked 2026-11-14).
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    models: [
      { id: 'k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', contextWindow: 262_144 },
      { id: 'k3', name: 'Kimi K3', contextWindow: 262_144 },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // The format's default body (adaptive, summarized) gives signed thinking
    // blocks. K3.1 Pro refuses `disabled` with a 400, so there is no off field;
    // with the toggle off the models still think, and Dez hides it. No
    // User-Agent header: requests work without one, and Kimi's terms forbid
    // a false client name.
    thinking: {},
  },
  {
    id: 'trustedrouter',
    name: 'TrustedRouter',
    baseUrl: 'https://api.trustedrouter.com/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    // /models lists every model with no query; `output_modalities=all`
    // lists none (checked live, 2026-11-19). The entries have OpenRouter's
    // shape. `created` is 0 for every model, so there is no release date.
    // https://api.trustedrouter.com/v1/models
    modelImageInput: { path: 'architecture.input_modalities' },
    // An image goes as an `image_url` data URL (checked live, 2026-11-19).
    // A list of request fields that the model takes: "tools" for a model
    // that calls tools, "reasoning" for one that takes the `reasoning`
    // field of `thinking` below. A tool round and its replay with the
    // `tool` message passed (checked live, 2026-11-19).
    modelToolCalling: { path: 'supported_parameters' },
    modelThinking: { path: 'supported_parameters' },
    // A list. The image, speech, transcription, and video models answer
    // through APIs that Dez has no format for here, so they are left out,
    // with the models whose type is embeddings or decision; a model that
    // writes text and images is a text model (checked live, 2026-11-19).
    modelOutputs: {
      path: 'architecture.output_modalities',
      values: {
        text: {
          outputs: ['text'],
          request: 'chat',
          // Some entries tell "text" but have no chat route: embedding
          // models ("text->embedding"), a Responses-only route, and tools
          // such as `deepseek/fetch`. Dez lists them and refuses a request
          // (checked live, 2026-11-19).
          requestBy: { path: 'trustedrouter.supports_chat', values: { false: 'none' } },
        },
        image: { outputs: [] },
        speech: { outputs: [] },
        transcription: { outputs: [] },
        video: { outputs: [] },
        embeddings: { outputs: [] },
        decision: { outputs: [] },
      },
    },
    // Texts of USD per token. The router and panel models
    // (`trustedrouter/auto`) give the price of their cheapest model, and
    // the price of their dearest one in `prompt_max`, which only they
    // have; so their price is unknown. Five panel and orchestration models
    // (`trustedrouter/synth`) list "0" for their tokens and no `prompt_max`;
    // their `route_kind` makes their price unknown too. `trustedrouter/free`
    // also lists "0", and it is free (`route_kind` "free_pool"). Checked
    // live, 2026-11-19.
    modelTokenPrices: {
      input: 'pricing.prompt',
      output: 'pricing.completion',
      cachedInput: 'pricing.input_cache_read',
      perTokens: 1,
      variableRate: 'pricing.prompt_max',
      variableRateBy: { path: 'trustedrouter.route_kind', values: ['fusion_panel', 'advisor_orchestration'] },
    },
    // The two numbers are the same for every model, and null for some
    // (checked live, 2026-11-19); the smaller one counts, as for
    // OpenRouter.
    modelContextWindow: { paths: ['context_length', 'top_provider.context_length'] },
    auth: 'apiKey',
    // A stream tells its token counts only when the request asks for them;
    // its usage chunk then has `cost_microdollars` and
    // `total_cost_microdollars` (checked live, 2026-11-19). TrustedRouter
    // refuses a field that it does not know (400) or does not support
    // (501), so the config sends no other fixed field.
    // https://trustedrouter.com/docs
    // https://trustedrouter.com/docs/migrate-from-openrouter
    requestBody: { stream_options: { include_usage: true } },
    // The key keeps a conversation on its last provider, whose prompt cache
    // holds it. A model whose `supported_parameters` lacks the field takes
    // it too (checked live, 2026-11-19).
    // https://trustedrouter.com/docs/prompt-caching
    promptCacheKey: true,
    // OpenRouter's field, which TrustedRouter takes; it goes only to a model
    // whose `supported_parameters` has "reasoning" (`modelThinking`). Some
    // models must think, so there is no off field. The thinking streams in
    // `reasoning` and `reasoning_content`, and a replay of either on the
    // assistant message of a tool round passed (checked live, 2026-11-19).
    thinking: { enabledBody: { reasoning: { enabled: true } } },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    // VS Code's Copilot Chat (microsoft/vscode, extensions/copilot) reads the
    // same flags. It sends the same header on requests with images, and it
    // sends no `tools` to a model without `tool_calls`
    // (src/platform/endpoint/node/chatEndpoint.ts). `missing: false` does the
    // same here: some models in the list, such as the embedding models, have
    // no `tool_calls` flag.
    modelImageInput: { path: 'capabilities.supports.vision' },
    modelToolCalling: { path: 'capabilities.supports.tool_calls', missing: false },
    // VS Code's Copilot Chat tells `chat` models apart from `completion`
    // (code completion) and `embeddings` models, and Zed lists only `chat`
    // models. `image` and `decisions` are newer values that a third-party
    // client reports from the live API.
    // `image` has no request: no client that Dez knows of shows the API of
    // these models. So Dez lists them, and refuses a message of the user
    // and a `model_invoke` call to one (`unusableModelMessage`).
    // https://github.com/microsoft/vscode/blob/5e718f45a0486f73460d307540aff922a22eaca9/extensions/copilot/src/platform/endpoint/common/endpointProvider.ts#L39
    // https://github.com/zed-industries/zed/blob/b36b283021c48f1712714b8a0e2ad6ffb578920b/crates/copilot_chat/src/copilot_chat.rs#L950-L955
    // https://github.com/Ashesh3/copilot-api/pull/146
    modelOutputs: {
      path: 'capabilities.type',
      values: {
        chat: { outputs: ['text'], request: 'chat' },
        completion: { outputs: [] },
        embeddings: { outputs: [] },
        decisions: { outputs: [] },
        image: { outputs: ['image'] },
      },
    },
    // VS Code's Copilot Chat takes `max_prompt_tokens` as the most tokens
    // of a prompt, and `max_prompt_images` as the most images of a request
    // (`limits` in endpointProvider.ts; chatEndpoint.ts). The list needs a
    // sign-in, so Dez has these names from that source only (checked
    // 2026-11-14).
    // https://github.com/microsoft/vscode/blob/5e718f45a0486f73460d307540aff922a22eaca9/extensions/copilot/src/platform/endpoint/common/endpointProvider.ts#L42-L47
    modelContextWindow: { paths: ['capabilities.limits.max_prompt_tokens', 'capabilities.limits.max_context_window_tokens'] },
    modelImageLimit: { paths: ['capabilities.limits.vision.max_prompt_images'] },
    auth: 'githubCopilot',
    // The Copilot API expects the headers of a supported editor integration.
    headers: {
      'Editor-Version': 'vscode/1.97.2',
      'Editor-Plugin-Version': 'copilot-chat/0.24.2',
      'User-Agent': 'GitHubCopilotChat/0.24.2',
      'Copilot-Integration-Id': 'vscode-chat',
    },
    imageRequestHeaders: { 'Copilot-Vision-Request': 'true' },
    // Copilot documents no thinking field, and `reasoning_effort` gives a 400
    // on models that do not list it. Its Claude and Gemini models stream
    // thinking without a field.
    thinking: {},
  },
]

export const BUILT_IN_PROVIDER_IDS: readonly string[] = BUILT_IN_PROVIDER_CONFIGS.map((config) => config.id)
