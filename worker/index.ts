type Env = {
  ASSETS: Fetcher;
  CARD_IMAGES: R2Bucket;
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_WORK_LABEL: string;
};

type CardPayload = {
  name?: string;
  nameZh?: string;
  nameEn?: string;
  company?: string;
  companyZh?: string;
  companyEn?: string;
  department?: string;
  departmentZh?: string;
  departmentEn?: string;
  title?: string;
  titleZh?: string;
  titleEn?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  website?: string;
  addressZh?: string;
  addressEn?: string;
  note?: string;
};

type ImageSide = "front" | "back";

type GoogleTokenRecord = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: string;
};

type GoogleCardRecord = Required<CardPayload> & {
  id: string;
  google_contact_resource_name: string | null;
  updatedAt: string;
};

type GooglePerson = {
  resourceName?: string;
  etag?: string;
  metadata?: Record<string, unknown>;
  names?: Array<Record<string, unknown>>;
  emailAddresses?: Array<Record<string, unknown>>;
  phoneNumbers?: Array<Record<string, unknown>>;
  organizations?: Array<Record<string, unknown>>;
  addresses?: Array<Record<string, unknown>>;
  urls?: Array<Record<string, unknown>>;
  biographies?: Array<Record<string, unknown>>;
  userDefined?: Array<Record<string, unknown>>;
  memberships?: Array<Record<string, unknown>>;
};

type RecognitionResult = Required<CardPayload> & {
  rawText: string;
  confidence: number | null;
};

const imageSides = new Set<ImageSide>(["front", "back"]);
const openAiChatCompletionsUrl = "https://api.openai.com/v1/chat/completions";
const defaultOpenAiModel = "gpt-4o-mini";
const googlePersonFields =
  "names,emailAddresses,phoneNumbers,organizations,addresses,urls,biographies,userDefined,memberships,metadata";
const googleUpdatePersonFields =
  "names,emailAddresses,phoneNumbers,organizations,addresses,urls,biographies,userDefined,memberships";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/cards" && request.method === "GET") {
      return listCards(env);
    }

    if (url.pathname === "/api/cards" && request.method === "POST") {
      return createCard(request, env);
    }

    const recognizeMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/recognize$/);
    if (recognizeMatch && request.method === "POST") {
      return recognizeCard(recognizeMatch[1], request, env);
    }

    const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (cardMatch && request.method === "PUT") {
      return updateCard(cardMatch[1], request, env);
    }
    if (cardMatch && request.method === "DELETE") {
      return deleteCard(cardMatch[1], request, env);
    }

    const imageMatch = url.pathname.match(
      /^\/api\/cards\/([^/]+)\/images\/(front|back)$/,
    );
    if (imageMatch && request.method === "GET") {
      return getCardImage(imageMatch[1], imageMatch[2] as ImageSide, request, env);
    }

    if (url.pathname === "/api/google/status" && request.method === "GET") {
      return googleStatus(env);
    }

    if (url.pathname === "/api/google/login" && request.method === "GET") {
      return googleLogin(request, env);
    }

    if (url.pathname === "/api/google/callback" && request.method === "GET") {
      return googleCallback(request, env);
    }

    if (url.pathname === "/api/google/sync" && request.method === "POST") {
      return syncGoogleContacts(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function googleStatus(env: Env): Promise<Response> {
  const token = await getGoogleToken(env);
  return json({
    connected: Boolean(token?.refresh_token),
    scope: token?.scope ?? "",
  });
}

async function googleLogin(request: Request, env: Env): Promise<Response> {
  const config = googleConfig(request, env);
  if (!config) {
    return json({ error: "缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET。" }, 501);
  }

  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `insert into google_oauth_states (state, redirect_path, created_at)
    values (?, '/', ?)`,
  )
    .bind(state, now)
    .run();

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "https://www.googleapis.com/auth/contacts");
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("include_granted_scopes", "true");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = googleConfig(request, env);
  if (!config) {
    return oauthRedirect(request, "missing_config");
  }

  const error = url.searchParams.get("error");
  if (error) {
    return oauthRedirect(request, error);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return oauthRedirect(request, "missing_code");
  }

  const stateRecord = await env.DB.prepare(
    `select state from google_oauth_states where state = ?`,
  )
    .bind(state)
    .first<{ state: string }>();
  if (!stateRecord) {
    return oauthRedirect(request, "state_mismatch");
  }
  await env.DB.prepare(`delete from google_oauth_states where state = ?`).bind(state).run();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });
  const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
  if (!tokenResponse.ok) {
    return oauthRedirect(request, asString(tokenPayload.error) || "token_exchange_failed");
  }

  const existing = await getGoogleToken(env);
  const refreshToken = asString(tokenPayload.refresh_token) || existing?.refresh_token || "";
  if (!refreshToken) {
    return oauthRedirect(request, "missing_refresh_token");
  }

  await saveGoogleToken(env, {
    access_token: asString(tokenPayload.access_token),
    refresh_token: refreshToken,
    expires_at: Date.now() + Number(tokenPayload.expires_in || 3600) * 1000,
    scope: asString(tokenPayload.scope),
    token_type: asString(tokenPayload.token_type) || "Bearer",
  });

  return oauthRedirect(request, "connected");
}

async function syncGoogleContacts(request: Request, env: Env): Promise<Response> {
  const config = googleConfig(request, env);
  if (!config) {
    return json({ error: "缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET。" }, 501);
  }

  const token = await ensureGoogleAccessToken(env, config);
  if (!token) {
    return json({ error: "尚未登入 Google，請先在設定裡登入。" }, 401);
  }

  const payload = await request.json().catch(() => ({})) as { label?: string };
  const label = (payload.label || env.GOOGLE_WORK_LABEL || "工作聯絡人").trim();
  const groupResourceName = await ensureContactGroup(token.access_token, label);
  const { results } = await env.DB.prepare(
    `select
      id, display_name as name, name_zh as nameZh, name_en as nameEn,
      company, company_zh as companyZh, company_en as companyEn,
      department, department_zh as departmentZh, department_en as departmentEn,
      title, title_zh as titleZh, title_en as titleEn, email, phone, mobile,
      fax, website, address_zh as addressZh, address_en as addressEn, note,
      updated_at as updatedAt, google_contact_resource_name
    from cards
    where google_sync_status != 'synced' or google_contact_resource_name is null
    order by updated_at asc
    limit 50`,
  ).all<GoogleCardRecord>();

  let created = 0;
  let updated = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const card of results) {
    try {
      const person = await upsertGoogleContact(
        token.access_token,
        card,
        groupResourceName,
        new URL(request.url).origin,
      );
      const now = new Date().toISOString();
      await env.DB.prepare(
        `update cards
        set google_label = ?, google_contact_resource_name = ?,
          google_sync_status = 'synced', google_sync_error = null,
          updated_at = ?
        where id = ?`,
      )
        .bind(label, person.resourceName || card.google_contact_resource_name || "", now, card.id)
        .run();
      if (card.google_contact_resource_name) {
        updated += 1;
      } else {
        created += 1;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "同步失敗";
      errors.push({ id: card.id, error: message });
      await env.DB.prepare(
        `update cards
        set google_sync_status = 'error', google_sync_error = ?
        where id = ?`,
      )
        .bind(message, card.id)
        .run();
    }
  }

  return json({
    ok: errors.length === 0,
    label,
    total: results.length,
    created,
    updated,
    errors,
  });
}

async function listCards(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select
      id, display_name, name_zh, name_en, company, company_zh, company_en,
      department, department_zh, department_en, title, title_zh, title_en, email, phone, mobile, fax, website,
      address_zh, address_en, note, front_image_url, back_image_url,
      google_sync_status, ai_confidence, created_at, updated_at
    from cards
    order by created_at desc`,
  ).all();

  return json({
    cards: results.map((card) => ({
      id: card.id,
      displayName: card.display_name,
      nameZh: card.name_zh,
      nameEn: card.name_en,
      company: card.company,
      companyZh: card.company_zh,
      companyEn: card.company_en,
      department: card.department,
      departmentZh: card.department_zh,
      departmentEn: card.department_en,
      title: card.title,
      titleZh: card.title_zh,
      titleEn: card.title_en,
      email: card.email,
      phone: card.phone,
      mobile: card.mobile,
      fax: card.fax,
      website: card.website,
      addressZh: card.address_zh,
      addressEn: card.address_en,
      note: card.note,
      frontUrl: imageUrl(card.id as string, "front", card.updated_at as string),
      backUrl: imageUrl(card.id as string, "back", card.updated_at as string),
      googleSyncStatus: card.google_sync_status,
      aiConfidence: card.ai_confidence,
      createdAt: card.created_at,
      updatedAt: card.updated_at,
    })),
  });
}

async function createCard(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const frontImage = formData.get("frontImage");
  const backImage = formData.get("backImage");
  const rawCard = formData.get("card");
  const hasFrontImage = frontImage instanceof File;
  const hasBackImage = backImage instanceof File;

  if (!hasFrontImage && !hasBackImage) {
    return json({ error: "至少需要一張名片照片。" }, 400);
  }

  if (typeof rawCard !== "string") {
    return json({ error: "缺少聯絡人資料。" }, 400);
  }

  const card = parseCardPayload(rawCard);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const primaryImage = (hasFrontImage ? frontImage : backImage) as File;
  const frontKey = hasFrontImage
    ? `cards/${id}/front-${safeFileName(frontImage.name)}`
    : `cards/${id}/front-${safeFileName(primaryImage.name)}`;
  const backKey = hasBackImage ? `cards/${id}/back-${safeFileName(backImage.name)}` : frontKey;
  const frontUrl = imageUrl(id, "front", now);
  const backUrl = imageUrl(id, "back", now);

  if (hasFrontImage) {
    await env.CARD_IMAGES.put(frontKey, frontImage.stream(), {
      httpMetadata: { contentType: frontImage.type || "image/jpeg" },
      customMetadata: { cardId: id, side: "front" },
    });
  } else {
    await env.CARD_IMAGES.put(frontKey, primaryImage.stream(), {
      httpMetadata: { contentType: primaryImage.type || "image/jpeg" },
      customMetadata: { cardId: id, side: "front" },
    });
  }

  if (hasBackImage) {
    await env.CARD_IMAGES.put(backKey, backImage.stream(), {
      httpMetadata: { contentType: backImage.type || "image/jpeg" },
      customMetadata: { cardId: id, side: "back" },
    });
  }

  await env.DB.prepare(
    `insert into cards (
      id, display_name, name_zh, name_en, company, company_zh, company_en,
      department, department_zh, department_en, title, title_zh, title_en, email, phone, mobile, fax, website,
      address_zh, address_en, note,
      front_image_key, back_image_key, front_image_url, back_image_url,
      google_label, google_sync_status, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      card.name ?? "",
      card.nameZh ?? "",
      card.nameEn ?? "",
      card.company ?? "",
      card.companyZh ?? "",
      card.companyEn ?? "",
      card.department ?? "",
      card.departmentZh ?? "",
      card.departmentEn ?? "",
      card.title ?? "",
      card.titleZh ?? "",
      card.titleEn ?? "",
      card.email ?? "",
      card.phone ?? "",
      card.mobile ?? "",
      card.fax ?? "",
      card.website ?? "",
      card.addressZh ?? "",
      card.addressEn ?? "",
      card.note ?? "",
      frontKey,
      backKey,
      frontUrl,
      backUrl,
      env.GOOGLE_WORK_LABEL,
      "pending",
      now,
      now,
    )
    .run();

  return json(
    {
      id,
      displayName: card.name ?? "",
      nameZh: card.nameZh ?? "",
      nameEn: card.nameEn ?? "",
      company: card.company ?? "",
      companyZh: card.companyZh ?? "",
      companyEn: card.companyEn ?? "",
      department: card.department ?? "",
      departmentZh: card.departmentZh ?? "",
      departmentEn: card.departmentEn ?? "",
      title: card.title ?? "",
      titleZh: card.titleZh ?? "",
      titleEn: card.titleEn ?? "",
      email: card.email ?? "",
      phone: card.phone ?? "",
      mobile: card.mobile ?? "",
      fax: card.fax ?? "",
      website: card.website ?? "",
      addressZh: card.addressZh ?? "",
      addressEn: card.addressEn ?? "",
      note: card.note ?? "",
      frontUrl,
      backUrl,
      googleSyncStatus: "pending",
    },
    201,
  );
}

async function updateCard(
  cardId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  const { card, frontImage, backImage } = contentType.includes("multipart/form-data")
    ? await parseMultipartUpdate(request)
    : await parseJsonUpdate(request);

  if (!card) {
    return json({ error: "缺少聯絡人資料。" }, 400);
  }

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `select front_image_key, back_image_key from cards where id = ?`,
  )
    .bind(cardId)
    .first<{ front_image_key: string; back_image_key: string }>();

  if (!existing) {
    return json({ error: "找不到要更新的名片。" }, 404);
  }

  let frontKey = existing.front_image_key;
  let backKey = existing.back_image_key;

  if (frontImage) {
    const nextFrontKey = `cards/${cardId}/front-${Date.now()}-${safeFileName(frontImage.name)}`;
    await env.CARD_IMAGES.put(nextFrontKey, frontImage.stream(), {
      httpMetadata: { contentType: frontImage.type || "image/jpeg" },
      customMetadata: { cardId, side: "front" },
    });
    await deleteOldImage(env, existing.front_image_key, existing.back_image_key);
    frontKey = nextFrontKey;
    if (backKey === existing.front_image_key) {
      backKey = nextFrontKey;
    }
  }

  if (backImage) {
    const nextBackKey = `cards/${cardId}/back-${Date.now()}-${safeFileName(backImage.name)}`;
    await env.CARD_IMAGES.put(nextBackKey, backImage.stream(), {
      httpMetadata: { contentType: backImage.type || "image/jpeg" },
      customMetadata: { cardId, side: "back" },
    });
    await deleteOldImage(env, existing.back_image_key, frontKey);
    backKey = nextBackKey;
  }

  const result = await env.DB.prepare(
    `update cards
    set display_name = ?, name_zh = ?, name_en = ?, company = ?,
      company_zh = ?, company_en = ?, department = ?, department_zh = ?,
      department_en = ?, title = ?, title_zh = ?, title_en = ?,
      email = ?, phone = ?, mobile = ?, fax = ?, website = ?,
      address_zh = ?, address_en = ?, note = ?, front_image_key = ?,
      back_image_key = ?, google_sync_status = 'pending',
      updated_at = ?
    where id = ?`,
  )
    .bind(
      card.name,
      card.nameZh,
      card.nameEn,
      card.company,
      card.companyZh,
      card.companyEn,
      card.department,
      card.departmentZh,
      card.departmentEn,
      card.title,
      card.titleZh,
      card.titleEn,
      card.email,
      card.phone,
      card.mobile,
      card.fax,
      card.website,
      card.addressZh,
      card.addressEn,
      card.note,
      frontKey,
      backKey,
      now,
      cardId,
    )
    .run();

  if (result.meta.changes === 0) {
    return json({ error: "找不到要更新的名片。" }, 404);
  }

  const updated = await env.DB.prepare(
    `select
      id, display_name, name_zh, name_en, company, company_zh, company_en,
      department, department_zh, department_en, title, title_zh, title_en, email, phone, mobile, fax, website,
      address_zh, address_en, note, front_image_url, back_image_url,
      google_sync_status, ai_confidence, created_at, updated_at
    from cards
    where id = ?`,
  )
    .bind(cardId)
    .first<Record<string, string>>();

  return json({
    id: updated?.id,
    displayName: updated?.display_name,
    nameZh: updated?.name_zh,
    nameEn: updated?.name_en,
    company: updated?.company,
    companyZh: updated?.company_zh,
    companyEn: updated?.company_en,
    department: updated?.department,
    departmentZh: updated?.department_zh,
    departmentEn: updated?.department_en,
    title: updated?.title,
    titleZh: updated?.title_zh,
    titleEn: updated?.title_en,
    email: updated?.email,
    phone: updated?.phone,
    mobile: updated?.mobile,
    fax: updated?.fax,
    website: updated?.website,
    addressZh: updated?.address_zh,
    addressEn: updated?.address_en,
    note: updated?.note,
    frontUrl: updated?.id ? imageUrl(updated.id, "front", updated.updated_at) : "",
    backUrl: updated?.id ? imageUrl(updated.id, "back", updated.updated_at) : "",
    googleSyncStatus: updated?.google_sync_status,
    aiConfidence: updated?.ai_confidence,
    createdAt: updated?.created_at,
    updatedAt: updated?.updated_at,
  });
}

async function parseJsonUpdate(request: Request): Promise<{
  card: Required<CardPayload> | null;
  frontImage: File | null;
  backImage: File | null;
}> {
  const rawCard = await request.json().catch(() => null);
  return {
    card: rawCard && typeof rawCard === "object"
      ? parseCardRecord(rawCard as Record<string, unknown>)
      : null,
    frontImage: null,
    backImage: null,
  };
}

async function parseMultipartUpdate(request: Request): Promise<{
  card: Required<CardPayload> | null;
  frontImage: File | null;
  backImage: File | null;
}> {
  const formData = await request.formData();
  const rawCard = formData.get("card");
  const frontImage = formData.get("frontImage");
  const backImage = formData.get("backImage");

  return {
    card: typeof rawCard === "string" ? parseCardPayload(rawCard) as Required<CardPayload> : null,
    frontImage: frontImage instanceof File ? frontImage : null,
    backImage: backImage instanceof File ? backImage : null,
  };
}

async function deleteOldImage(env: Env, key: string, protectedKey: string) {
  if (key !== protectedKey) {
    await env.CARD_IMAGES.delete(key);
  }
}

async function recognizeCard(cardId: string, request: Request, env: Env): Promise<Response> {
  const record = await env.DB.prepare(
    `select
      front_image_key, back_image_key,
      display_name, name_zh, name_en, company, company_zh, company_en,
      department, department_zh, department_en, title, title_zh, title_en,
      email, phone, mobile, fax, website, address_zh, address_en, note,
      google_sync_status, updated_at
    from cards
    where id = ?`,
  )
    .bind(cardId)
    .first<Record<string, string>>();

  if (!record) {
    return json({ error: "找不到要辨識的名片。" }, 404);
  }

  const side: ImageSide = new URL(request.url).searchParams.get("side") === "back"
    ? "back"
    : "front";
  const url = new URL(request.url);
  try {
    const recognition = await recognizeImage(
      side === "back" ? record.back_image_key : record.front_image_key,
      side,
      env,
    );
    const merged = side === "back"
      ? mergeRecognition(emptyRecognition(), recognition)
      : reconcileWithExisting(
        mergeRecognition(recognition, emptyRecognition()),
        cardPayloadFromDb(record),
      );
    cleanMergedFields(merged);
    const updatedAt = record.updated_at || new Date().toISOString();

    return json({
      card: {
        id: cardId,
        displayName: merged.name,
        nameZh: merged.nameZh,
        nameEn: merged.nameEn,
        company: merged.company,
        companyZh: merged.companyZh,
        companyEn: merged.companyEn,
        department: merged.department,
        departmentZh: merged.departmentZh,
        departmentEn: merged.departmentEn,
        title: merged.title,
        titleZh: merged.titleZh,
        titleEn: merged.titleEn,
        email: merged.email,
        phone: merged.phone,
        mobile: merged.mobile,
        fax: merged.fax,
        website: merged.website,
        addressZh: merged.addressZh,
        addressEn: merged.addressEn,
        note: merged.note,
        frontUrl: imageUrl(cardId, "front", updatedAt),
        backUrl: imageUrl(cardId, "back", updatedAt),
        googleSyncStatus: record.google_sync_status || "pending",
        aiConfidence: merged.confidence,
        updatedAt,
      },
      recognition: merged,
      side,
      provider: "openai",
      model: env.OPENAI_MODEL || defaultOpenAiModel,
      saved: false,
    });
  } catch (cause) {
    return json({
      error: errorMessage(cause) || "辨識失敗。",
      provider: "openai",
      model: env.OPENAI_MODEL || defaultOpenAiModel,
    }, 502);
  }
}

async function recognizeImage(
  imageKey: string,
  side: ImageSide,
  env: Env,
): Promise<RecognitionResult> {
  const object = await env.CARD_IMAGES.get(imageKey);
  if (!object) {
    throw new Error(`找不到名片${side === "front" ? "正面" : "背面"}圖片。`);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = headers.get("content-type") || "image/jpeg";
  const image = await object.arrayBuffer();
  const imageDataUrl = `data:${contentType};base64,${arrayBufferToBase64(image)}`;
  const prompt = [
    `這是名片${side === "front" ? "正面" : "背面"}圖片。`,
    "請辨識名片文字，並只輸出一個 JSON object，不要 markdown，不要解釋。",
    "請先判斷這一面的主要語言。中文資料只放入 *Zh 欄位，英文資料只放入 *En 欄位。",
    "如果這一面只有英文，不要把英文姓名、公司、職稱、地址填到 *Zh 欄位。",
    "如果這一面只有中文，不要把中文姓名、公司、職稱、地址填到 *En 欄位。",
    "姓名欄位只能放真人姓名，不要把 logo、品牌名或公司名當姓名。",
    "company 是公司、基金會、協會、法人、Corporation、Ltd、Foundation、Association 等組織主體。",
    "法律事務所、專利商標事務所、會計師事務所屬於 company，不是 department 或 title。",
    "department 是部門、中心、處、組、事業部、Division、Department、Center、Office；不要把 department 填進 company。",
    "title 只放職稱，例如主任、經理、專員、Chairman、Manager，不要包含部門。",
    "地址只能放 addressZh/addressEn，不可放到 title 或 department。",
    "電子信箱只能放 email，不可放到 titleEn/nameEn。",
    "如果一行同時包含部門和職稱，例如「市場拓展處 副處長」，請拆成 departmentZh=市場拓展處、titleZh=副處長。",
    "不要翻譯或推測圖片上沒有出現的英文姓名、英文公司、英文職稱、英文地址。",
    "rawText 請放圖片上可見的原始文字，每行用換行分隔；不要把 JSON 放進 rawText。",
    "通用顯示欄位 name/company/department/title 可放這一面最完整的版本。",
    "欄位固定為：",
    '{"name":"","nameZh":"","nameEn":"","company":"","companyZh":"","companyEn":"","department":"","departmentZh":"","departmentEn":"","title":"","titleZh":"","titleEn":"","email":"","phone":"","mobile":"","fax":"","website":"","addressZh":"","addressEn":"","note":"","rawText":"","confidence":0}',
    "phone 放公司電話，mobile 放手機，fax 放傳真。沒有資料請用空字串。confidence 是 0 到 1。",
    "看到「電話、手機、傳真、E-mail、網址、統編」標籤時，請分別填入 phone、mobile、fax、email、website、note。",
  ].join("\n");

  const messages = [
    {
      role: "system",
      content:
        "你是精準的名片 OCR 與聯絡人資料結構化助理，擅長繁體中文與英文名片。",
    },
    { role: "user", content: prompt },
  ];

  const response = await runOpenAiVision(env, messages[0].content, messages[1].content, imageDataUrl);

  const text = aiResponseText(response);
  return parseRecognition(text);
}

async function runOpenAiVision(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string,
): Promise<unknown> {
  const model = env.OPENAI_MODEL || defaultOpenAiModel;
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 尚未設定，請先在 Cloudflare Worker Secret 設定 API key。");
  }
  let response: Response;
  try {
    response = await fetch(openAiChatCompletionsUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 2200,
        temperature: 0,
      }),
    });
  } catch (cause) {
    throw new Error(
      `OpenAI 連線失敗：${errorMessage(cause) || "無法連線到模型服務"}。`,
    );
  }

  let rawPayload = "";
  try {
    rawPayload = await response.text();
  } catch (cause) {
    throw new Error(
      `OpenAI 回應讀取失敗（HTTP ${response.status} ${response.statusText}）：`
      + `${errorMessage(cause) || "連線在讀取回應時中斷"}。`
    );
  }
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    throw new Error(
      `OpenAI 視覺辨識失敗：HTTP ${response.status} ${response.statusText}`
      + (rawPayload ? `，${rawPayload.slice(0, 500)}` : ""),
    );
  }
  return Object.keys(payload).length ? payload : rawPayload;
}

async function deleteCard(cardId: string, request: Request, env: Env): Promise<Response> {
  const deleteGoogle = new URL(request.url).searchParams.get("google") === "delete";
  const record = await env.DB.prepare(
    `select front_image_key, back_image_key, google_contact_resource_name
    from cards
    where id = ?`,
  )
    .bind(cardId)
    .first<{
      front_image_key: string;
      back_image_key: string;
      google_contact_resource_name: string | null;
    }>();

  if (!record) {
    return json({ error: "找不到要刪除的名片。" }, 404);
  }

  let googleDeleted = false;
  if (deleteGoogle) {
    if (!record.google_contact_resource_name) {
      return json({ error: "這張名片尚未同步到 Google，無法刪除 Google 聯絡人。" }, 400);
    }
    const config = googleConfig(request, env);
    if (!config) {
      return json({ error: "缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET。" }, 501);
    }
    const token = await ensureGoogleAccessToken(env, config);
    if (!token) {
      return json({ error: "尚未登入 Google，請先在設定裡登入。" }, 401);
    }
    await deleteGoogleContact(token.access_token, record.google_contact_resource_name);
    googleDeleted = true;
  }

  await Promise.all([
    env.CARD_IMAGES.delete(record.front_image_key),
    record.back_image_key === record.front_image_key
      ? Promise.resolve()
      : env.CARD_IMAGES.delete(record.back_image_key),
  ]);

  await env.DB.prepare(`delete from cards where id = ?`).bind(cardId).run();
  return json({ ok: true, googleDeleted });
}

async function getCardImage(
  cardId: string,
  side: ImageSide,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!imageSides.has(side)) {
    return json({ error: "不支援的圖片方向。" }, 400);
  }

  const column = side === "front" ? "front_image_key" : "back_image_key";
  const record = await env.DB.prepare(
    `select ${column} as image_key from cards where id = ?`,
  )
    .bind(cardId)
    .first<{ image_key: string }>();

  if (!record?.image_key) {
    return json({ error: "找不到名片圖片。" }, 404);
  }

  const object = await env.CARD_IMAGES.get(record.image_key);
  if (!object) {
    return json({ error: "找不到名片圖片檔案。" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  const hasVersion = new URL(request.url).searchParams.has("v");
  headers.set(
    "cache-control",
    hasVersion ? "private, max-age=31536000, immutable" : "private, max-age=300",
  );
  return new Response(object.body, { headers });
}

function googleConfig(request: Request, env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${new URL(request.url).origin}/api/google/callback`,
  };
}

function oauthRedirect(request: Request, google: string): Response {
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/?google=${encodeURIComponent(google)}`, 302);
}

async function getGoogleToken(env: Env): Promise<GoogleTokenRecord | null> {
  return env.DB.prepare(
    `select access_token, refresh_token, expires_at, scope, token_type
    from google_tokens
    where id = 'default'`,
  ).first<GoogleTokenRecord>();
}

async function saveGoogleToken(env: Env, token: GoogleTokenRecord): Promise<void> {
  await env.DB.prepare(
    `insert into google_tokens (
      id, access_token, refresh_token, expires_at, scope, token_type, updated_at
    ) values ('default', ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      token_type = excluded.token_type,
      updated_at = excluded.updated_at`,
  )
    .bind(
      token.access_token,
      token.refresh_token,
      token.expires_at,
      token.scope,
      token.token_type,
      new Date().toISOString(),
    )
    .run();
}

async function ensureGoogleAccessToken(
  env: Env,
  config: NonNullable<ReturnType<typeof googleConfig>>,
): Promise<GoogleTokenRecord | null> {
  const token = await getGoogleToken(env);
  if (!token?.refresh_token) {
    return null;
  }
  if (token.access_token && token.expires_at > Date.now() + 60_000) {
    return token;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(asString(payload.error_description) || "Google access token 更新失敗。");
  }

  const next = {
    access_token: asString(payload.access_token),
    refresh_token: token.refresh_token,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
    scope: asString(payload.scope) || token.scope,
    token_type: asString(payload.token_type) || token.token_type || "Bearer",
  };
  await saveGoogleToken(env, next);
  return next;
}

async function ensureContactGroup(accessToken: string, label: string): Promise<string> {
  const existing = await googleFetch<{ contactGroups?: Array<{ resourceName: string; name: string }> }>(
    "https://people.googleapis.com/v1/contactGroups?pageSize=1000&groupFields=name",
    accessToken,
  );
  const found = existing.contactGroups?.find((group) => group.name === label);
  if (found?.resourceName) {
    return found.resourceName;
  }

  const created = await googleFetch<{ resourceName?: string }>(
    "https://people.googleapis.com/v1/contactGroups",
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({ contactGroup: { name: label } }),
    },
  );
  if (!created.resourceName) {
    throw new Error("建立 Google 聯絡人標籤失敗。");
  }
  return created.resourceName;
}

async function upsertGoogleContact(
  accessToken: string,
  card: GoogleCardRecord,
  groupResourceName: string,
  origin: string,
): Promise<GooglePerson> {
  const person = cardToGooglePerson(card, groupResourceName, origin);
  if (!card.google_contact_resource_name) {
    return googleFetch<GooglePerson>(
      `https://people.googleapis.com/v1/people:createContact?personFields=${googlePersonFields}`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify(person),
      },
    );
  }

  const current = await googleFetch<GooglePerson>(
    `https://people.googleapis.com/v1/${card.google_contact_resource_name}?personFields=${googlePersonFields}`,
    accessToken,
  );
  return googleFetch<GooglePerson>(
    `https://people.googleapis.com/v1/${card.google_contact_resource_name}:updateContact?updatePersonFields=${googleUpdatePersonFields}&personFields=${googlePersonFields}`,
    accessToken,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...person,
        resourceName: current.resourceName || card.google_contact_resource_name,
        etag: current.etag,
        metadata: current.metadata,
      }),
    },
  );
}

async function deleteGoogleContact(
  accessToken: string,
  resourceName: string,
): Promise<void> {
  const response = await fetch(
    `https://people.googleapis.com/v1/${resourceName}:deleteContact`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (response.ok || response.status === 404) {
    return;
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const error = asString(payload.error_description)
    || asString(typeof payload.error === "object" && payload.error ? (payload.error as Record<string, unknown>).message : payload.error)
    || `Google 刪除失敗：${response.status}`;
  throw new Error(error);
}

function cardToGooglePerson(
  card: GoogleCardRecord,
  groupResourceName: string,
  origin: string,
): GooglePerson {
  const frontUrl = `${origin}${imageUrl(card.id, "front", card.updatedAt)}`;
  const backUrl = `${origin}${imageUrl(card.id, "back", card.updatedAt)}`;
  const name = card.name || card.nameZh || card.nameEn || card.company || card.companyZh || card.companyEn;
  const company = card.company || card.companyZh || card.companyEn;
  const department = card.department || card.departmentZh || card.departmentEn;
  const title = card.title || card.titleZh || card.titleEn;
  const noteLines = [
    card.note,
    "名片正面：" + frontUrl,
    "名片背面：" + backUrl,
  ].filter(Boolean);

  return removeEmptyPersonFields({
    names: name ? [{ unstructuredName: name }] : [],
    emailAddresses: card.email ? [{ value: card.email, type: "work" }] : [],
    phoneNumbers: [
      card.phone ? { value: card.phone, type: "work" } : null,
      card.mobile ? { value: card.mobile, type: "mobile" } : null,
      card.fax ? { value: card.fax, type: "workFax" } : null,
    ].filter(Boolean) as Array<Record<string, unknown>>,
    organizations: company || department || title ? [{ name: company, department, title, type: "work" }] : [],
    addresses: [
      card.addressZh ? { formattedValue: card.addressZh, type: "work" } : null,
      card.addressEn ? { formattedValue: card.addressEn, type: "work" } : null,
    ].filter(Boolean) as Array<Record<string, unknown>>,
    urls: [
      card.website ? { value: card.website, type: "work" } : null,
      { value: frontUrl, type: "other", formattedType: "名片正面" },
      { value: backUrl, type: "other", formattedType: "名片背面" },
    ].filter(Boolean) as Array<Record<string, unknown>>,
    biographies: noteLines.length
      ? [{ value: noteLines.join("\n"), contentType: "TEXT_PLAIN" }]
      : [],
    userDefined: [
      card.nameZh ? { key: "nameZh", value: card.nameZh } : null,
      card.nameEn ? { key: "nameEn", value: card.nameEn } : null,
      card.companyZh ? { key: "companyZh", value: card.companyZh } : null,
      card.companyEn ? { key: "companyEn", value: card.companyEn } : null,
      card.departmentZh ? { key: "departmentZh", value: card.departmentZh } : null,
      card.departmentEn ? { key: "departmentEn", value: card.departmentEn } : null,
      card.titleZh ? { key: "titleZh", value: card.titleZh } : null,
      card.titleEn ? { key: "titleEn", value: card.titleEn } : null,
      { key: "businessCardFrontUrl", value: frontUrl },
      { key: "businessCardBackUrl", value: backUrl },
      { key: "businessCardId", value: card.id },
    ].filter(Boolean) as Array<Record<string, unknown>>,
    memberships: [
      { contactGroupMembership: { contactGroupResourceName: groupResourceName } },
    ],
  });
}

function removeEmptyPersonFields(person: GooglePerson): GooglePerson {
  return Object.fromEntries(
    Object.entries(person).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as GooglePerson;
}

async function googleFetch<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = asString(payload.error_description)
      || asString(typeof payload.error === "object" && payload.error ? (payload.error as Record<string, unknown>).message : payload.error)
      || `Google API 錯誤：${response.status}`;
    throw new Error(error);
  }
  return payload as T;
}

function parseCardPayload(raw: string): CardPayload {
  try {
    return parseCardRecord(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

function parseCardRecord(parsed: Record<string, unknown>): Required<CardPayload> {
  const nameZh = asString(parsed.nameZh);
  const nameEn = asString(parsed.nameEn);
  const companyZh = asString(parsed.companyZh);
  const companyEn = asString(parsed.companyEn);
  const departmentZh = asString(parsed.departmentZh);
  const departmentEn = asString(parsed.departmentEn);
  const titleZh = asString(parsed.titleZh);
  const titleEn = asString(parsed.titleEn);

  return {
    name: asString(parsed.name) || nameZh || nameEn,
    nameZh,
    nameEn,
    company: asString(parsed.company) || companyZh || companyEn,
    companyZh,
    companyEn,
    department: asString(parsed.department) || departmentZh || departmentEn,
    departmentZh,
    departmentEn,
    title: asString(parsed.title) || titleZh || titleEn,
    titleZh,
    titleEn,
    email: asString(parsed.email),
    phone: asString(parsed.phone),
    mobile: asString(parsed.mobile),
    fax: asString(parsed.fax),
    website: asString(parsed.website),
    addressZh: asString(parsed.addressZh),
    addressEn: asString(parsed.addressEn),
    note: asString(parsed.note),
  };
}

function cardPayloadFromDb(record: Record<string, string>): Required<CardPayload> {
  return {
    name: record.display_name || "",
    nameZh: record.name_zh || "",
    nameEn: record.name_en || "",
    company: record.company || "",
    companyZh: record.company_zh || "",
    companyEn: record.company_en || "",
    department: record.department || "",
    departmentZh: record.department_zh || "",
    departmentEn: record.department_en || "",
    title: record.title || "",
    titleZh: record.title_zh || "",
    titleEn: record.title_en || "",
    email: record.email || "",
    phone: record.phone || "",
    mobile: record.mobile || "",
    fax: record.fax || "",
    website: record.website || "",
    addressZh: record.address_zh || "",
    addressEn: record.address_en || "",
    note: record.note || "",
  };
}

function parseRecognition(text: string): RecognitionResult {
  const parsed = bestParsedRecognition(text);
  const card = normalizeLanguageFields(parseCardRecord(parsed));
  const confidence = Number(parsed.confidence);
  const rawText = asString(parsed.rawText) || text;
  fillFromRawText(card, rawText);
  return {
    ...card,
    rawText,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
  };
}

function bestParsedRecognition(text: string): Record<string, unknown> {
  const parsed = parseJsonObject(text);
  const loose = parseLooseJsonFields(text);
  const markdown = parseMarkdownFields(text);
  const candidates = [parsed, loose, markdown].filter(Boolean) as Array<Record<string, unknown>>;
  return candidates.reduce((best, candidate) =>
    recognitionFieldScore(candidate) > recognitionFieldScore(best)
      ? { ...best, ...candidate }
      : best,
  parsed);
}

function parseMarkdownFields(text: string): Record<string, unknown> | null {
  const keyMap: Record<string, keyof Required<CardPayload> | "rawText" | "confidence"> = {
    Name: "name",
    NameZh: "nameZh",
    NameEn: "nameEn",
    Company: "company",
    CompanyZh: "companyZh",
    CompanyEn: "companyEn",
    Department: "department",
    DepartmentZh: "departmentZh",
    DepartmentEn: "departmentEn",
    Title: "title",
    TitleZh: "titleZh",
    TitleEn: "titleEn",
    Email: "email",
    Phone: "phone",
    Mobile: "mobile",
    Fax: "fax",
    Website: "website",
    AddressZh: "addressZh",
    AddressEn: "addressEn",
    Note: "note",
    RawText: "rawText",
    Confidence: "confidence",
  };
  const parsed: Record<string, unknown> = {};
  const labelPattern = Object.keys(keyMap).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*\\*\\*(${labelPattern})\\s*:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*(?:${labelPattern})\\s*:\\*\\*|$)`, "g");
  for (const match of text.matchAll(pattern)) {
    const field = keyMap[match[1]];
    const value = cleanAiField(match[2]);
    if (value) {
      parsed[field] = value;
    }
  }
  return Object.keys(parsed).length ? parsed : null;
}

function recognitionFieldScore(parsed: Record<string, unknown>): number {
  return [
    "nameZh", "nameEn", "company", "companyZh", "companyEn",
    "departmentZh", "departmentEn", "titleZh", "titleEn",
    "email", "phone", "mobile", "fax", "website", "addressZh", "addressEn",
  ].filter((key) => asString(parsed[key])).length;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return unwrapAiJson(JSON.parse(text) as Record<string, unknown>);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { rawText: text };
    }
    try {
      return unwrapAiJson(JSON.parse(match[0]) as Record<string, unknown>);
    } catch {
      return parseLooseJsonFields(match[0]) || parseLooseJsonFields(text) || { rawText: text };
    }
  }
}

function unwrapAiJson(parsed: Record<string, unknown>): Record<string, unknown> {
  if (parsed.response && typeof parsed.response === "object") {
    return parsed.response as Record<string, unknown>;
  }
  return parsed;
}

function parseLooseJsonFields(text: string): Record<string, unknown> | null {
  const candidates = [
    text,
    text.replace(/\\"/g, "\"").replace(/\\n/g, "\n"),
  ];
  const keys = [
    "name", "nameZh", "nameEn", "company", "companyZh", "companyEn",
    "department", "departmentZh", "departmentEn", "title", "titleZh", "titleEn",
    "email", "phone", "mobile", "fax", "website", "addressZh", "addressEn", "note",
  ];
  for (const candidate of candidates) {
    const parsed: Record<string, unknown> = {};
    for (const key of keys) {
      const match = candidate.match(new RegExp(`"?${key}"?\\s*:\\s*"((?:\\\\.|[^"])*)"`, "s"));
      if (match?.[1]) {
        parsed[key] = match[1]
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, "\"")
          .trim();
      }
    }
    if (Object.keys(parsed).length) {
      return parsed;
    }
  }
  return null;
}

function mergeRecognition(
  front: RecognitionResult,
  back: RecognitionResult,
): RecognitionResult {
  const frontNormalized = normalizeLanguageFields(front);
  const backNormalized = back.confidence === 0 ? emptyRecognition() : normalizeLanguageFields(back);
  const companyCandidates = [
    frontNormalized.company,
    frontNormalized.companyZh,
    frontNormalized.companyEn,
    backNormalized.company,
    backNormalized.companyZh,
    backNormalized.companyEn,
  ];
  const nameZh = pickChinesePersonName(
    [
      frontNormalized.nameZh,
      backNormalized.nameZh,
      frontNormalized.name,
      backNormalized.name,
    ],
    companyCandidates,
  );
  const nameEn = pickEnglishPersonName(
    [
      frontNormalized.nameEn,
      frontNormalized.name,
      backNormalized.nameEn,
      backNormalized.name,
    ],
    companyCandidates,
  );
  const merged: RecognitionResult = {
    nameZh,
    nameEn,
    name: "",
    companyZh: prefer(frontNormalized.companyZh, backNormalized.companyZh),
    companyEn: prefer(frontNormalized.companyEn, backNormalized.companyEn),
    company: "",
    departmentZh: prefer(frontNormalized.departmentZh, backNormalized.departmentZh),
    departmentEn: prefer(frontNormalized.departmentEn, backNormalized.departmentEn),
    department: "",
    titleZh: prefer(frontNormalized.titleZh, backNormalized.titleZh),
    titleEn: prefer(frontNormalized.titleEn, backNormalized.titleEn),
    title: "",
    email: prefer(frontNormalized.email, backNormalized.email),
    phone: prefer(frontNormalized.phone, backNormalized.phone),
    mobile: prefer(frontNormalized.mobile, backNormalized.mobile),
    fax: prefer(frontNormalized.fax, backNormalized.fax),
    website: prefer(frontNormalized.website, backNormalized.website),
    addressZh: prefer(frontNormalized.addressZh, backNormalized.addressZh),
    addressEn: prefer(frontNormalized.addressEn, backNormalized.addressEn),
    note: prefer(frontNormalized.note, backNormalized.note),
    rawText: [front.rawText, back.rawText].filter(Boolean).join("\n\n---\n\n"),
    confidence: averageConfidence(front.confidence, back.confidence),
  };

  merged.name = merged.nameZh || merged.nameEn || "";
  inferCompanyAndDepartment(merged);
  fillFromRawText(merged, merged.rawText);
  cleanMergedFields(merged);
  merged.company = merged.companyZh || merged.companyEn || prefer(frontNormalized.company, backNormalized.company);
  merged.department = merged.departmentZh || merged.departmentEn || prefer(frontNormalized.department, backNormalized.department);
  merged.title = merged.titleZh || merged.titleEn || prefer(frontNormalized.title, backNormalized.title);
  fillFromRawText(merged, merged.rawText);
  cleanMergedFields(merged);
  merged.name = merged.nameZh || merged.nameEn || "";
  merged.company = merged.companyZh || merged.companyEn || prefer(frontNormalized.company, backNormalized.company);
  merged.department = merged.departmentZh || merged.departmentEn || prefer(frontNormalized.department, backNormalized.department);
  merged.title = merged.titleZh || merged.titleEn || prefer(frontNormalized.title, backNormalized.title);
  return merged;
}

function reconcileWithExisting(
  merged: RecognitionResult,
  existing: Required<CardPayload>,
): RecognitionResult {
  const previous = normalizeLanguageFields(existing);
  const next = { ...merged };

  cleanMergedFields(previous);

  if (!next.nameZh && previous.nameZh && isLikelyChinesePersonName(previous.nameZh, [])) {
    next.nameZh = previous.nameZh;
  }
  if (!next.nameEn && previous.nameEn) {
    next.nameEn = previous.nameEn;
  }

  const companyLooksLikeDepartment = Boolean(next.companyZh && isLikelyDepartment(next.companyZh) && !isLikelyChineseCompany(next.companyZh))
    || Boolean(next.companyEn && isLikelyDepartment(next.companyEn) && !isLikelyEnglishCompany(next.companyEn));
  if ((!next.companyZh || companyLooksLikeDepartment) && previous.companyZh && !isLikelyDepartment(previous.companyZh)) {
    next.companyZh = previous.companyZh;
  }
  if ((!next.companyEn || companyLooksLikeDepartment) && previous.companyEn && isLikelyEnglishCompany(previous.companyEn)) {
    next.companyEn = previous.companyEn;
  }
  if ((!next.company || companyLooksLikeDepartment) && previous.company && !isLikelyDepartment(previous.company)) {
    next.company = previous.company;
  }

  if (!next.departmentZh && previous.departmentZh) {
    next.departmentZh = previous.departmentZh;
  }
  if (!next.departmentEn && previous.departmentEn) {
    next.departmentEn = previous.departmentEn;
  }
  if (!next.titleZh && previous.titleZh && isLikelyTitle(previous.titleZh)) {
    next.titleZh = previous.titleZh;
  }
  if (!next.titleEn && previous.titleEn && isLikelyTitle(previous.titleEn)) {
    next.titleEn = previous.titleEn;
  }
  if (!next.email && previous.email && isEmail(previous.email)) {
    next.email = previous.email;
  }
  if (!next.phone && previous.phone) {
    next.phone = previous.phone;
  }
  if (!next.website && previous.website) {
    next.website = previous.website;
  }
  if (!next.addressZh && previous.addressZh) {
    next.addressZh = previous.addressZh;
  }
  if (!next.addressEn && previous.addressEn) {
    next.addressEn = previous.addressEn;
  }

  cleanMergedFields(next);
  next.name = next.nameZh || next.nameEn || "";
  next.company = next.companyZh || next.companyEn || next.company || "";
  next.department = next.departmentZh || next.departmentEn || next.department || "";
  next.title = next.titleZh || next.titleEn || next.title || "";
  return next;
}

function pickChinesePersonName(values: string[], companyCandidates: string[]): string {
  return values.find((value) => isLikelyChinesePersonName(value, companyCandidates)) || "";
}

function pickEnglishPersonName(values: string[], companyCandidates: string[]): string {
  return values.find((value) => isLikelyEnglishPersonName(value, companyCandidates)) || "";
}

function isLikelyChinesePersonName(value: string, companyCandidates: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed || isSameAsCompany(trimmed, companyCandidates)) {
    return false;
  }
  if (!/^[\u3400-\u9fff·・]{2,6}$/.test(trimmed)) {
    return false;
  }
  return !/(公司|股份|有限|分公司|集團|控股|台灣|臺灣|香港|品牌|科技|銀行|醫院|學校)/.test(trimmed);
}

function isLikelyEnglishPersonName(value: string, companyCandidates: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksChineseLike(trimmed) || isSameAsCompany(trimmed, companyCandidates)) {
    return false;
  }
  if (/\b(inc|ltd|limited|corp|corporation|company|branch|holdings|group|taiwan|hong kong|commercial|times|news|media|international|patent|trademark|office|law|foundation|association)\b/i.test(trimmed)) {
    return false;
  }
  if (isLikelyTitle(trimmed) || isLikelyDepartment(trimmed)) {
    return false;
  }
  const words = trimmed
    .replace(/[.,;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2 || words.length > 5) {
    return false;
  }
  return words.every((word) => /^[A-Za-z][A-Za-z'-]*$/.test(word));
}

function isSameAsCompany(value: string, companyCandidates: string[]): boolean {
  const normalized = normalizeComparableText(value);
  return companyCandidates.some(
    (candidate) =>
      normalized &&
      normalizeComparableText(candidate) === normalized,
  );
}

function fillFromRawText(card: Required<CardPayload>, rawText: string): void {
  const lines = recognitionTextLines(rawText);

  if (!card.nameEn) {
    const name = findEnglishPersonName(lines, [
      card.company,
      card.companyZh,
      card.companyEn,
      card.department,
      card.departmentZh,
      card.departmentEn,
    ]) || findSimpleEnglishName(lines);
    if (name) {
      card.nameEn = name;
    }
  }
  if (!card.nameEn && card.email) {
    card.nameEn = nameFromEmail(card.email);
  }

  if (!card.nameZh) {
    const name = findChinesePersonNameFromText(lines.join("\n"), [
      card.company,
      card.companyZh,
      card.companyEn,
      card.department,
      card.departmentZh,
      card.departmentEn,
    ]);
    if (name) {
      card.nameZh = name;
    }
  }

  if (!card.addressZh || hasMixedLanguageAddress(card.addressZh)) {
    const address = lines.map(extractChineseAddress).find(Boolean);
    if (address) {
      card.addressZh = address;
    }
  }

  if (!card.phone) {
    const phone = findPhoneLine(lines);
    if (phone) {
      card.phone = phone;
    }
  }

  if (card.fax && /^\d{8}$/.test(card.fax) && lines.some((line) => /傳真|Fax/i.test(line))) {
    card.fax = "";
  }
  if (!card.fax) {
    const fax = findFaxLine(lines);
    if (fax) {
      card.fax = fax;
    }
  }

  if (!card.website) {
    const website = findWebsiteLine(lines);
    if (website) {
      card.website = website;
    }
  }

  if (!card.note) {
    const taxId = findTaxIdLine(lines);
    if (taxId) {
      card.note = taxId;
    }
  }

  if (!card.companyEn || isJunkField(card.companyEn)) {
    const company = lines.find(isLikelyEnglishCompany);
    if (company) {
      card.companyEn = company;
    }
  }

  if (!card.companyZh) {
    const company = lines.find(isLikelyChineseCompany);
    if (company) {
      card.companyZh = company;
    }
  }
}

function cleanMergedFields(card: Required<CardPayload> & { rawText?: string }): void {
  for (const field of ["nameEn", "company", "companyZh", "companyEn", "department", "departmentZh", "departmentEn", "title", "titleZh", "titleEn", "addressZh", "addressEn"] as Array<keyof Required<CardPayload>>) {
    card[field] = cleanAiField(card[field]);
    if (isJunkField(card[field])) {
      card[field] = "";
    }
  }
  for (const field of ["name", "nameZh", "email", "phone", "mobile", "fax", "website", "note"] as Array<keyof Required<CardPayload>>) {
    card[field] = cleanAiField(card[field]);
  }
  if (/^人[\u3400-\u9fff]{3}$/.test(card.nameZh)) {
    card.nameZh = card.nameZh.slice(1);
  }
  if (card.note && /統編|統一編號/.test(card.note)) {
    card.note = findTaxIdLine([card.note]) || card.note;
  }
  if (card.addressZh) {
    card.addressZh = extractChineseAddress(card.addressZh) || card.addressZh;
    card.addressZh = normalizeChineseAddress(card.addressZh);
  }
  card.departmentZh = normalizeCommonOcrText(card.departmentZh);
  card.titleZh = normalizeCommonOcrText(card.titleZh);
  if (card.titleZh && isLikelyChineseAddress(card.titleZh)) {
    if (!card.addressZh) {
      card.addressZh = extractChineseAddress(card.titleZh) || card.titleZh;
    }
    card.titleZh = "";
  }
  if (card.titleEn && isEmail(card.titleEn)) {
    if (!card.email) {
      card.email = card.titleEn;
    }
    card.titleEn = "";
  }
  repairEnglishFieldsFromRawText(card);
  if (card.fax && !isLikelyPhoneNumber(card.fax)) {
    if (!card.note && /^[A-Za-z0-9._-]{3,}$/.test(card.fax)) {
      card.note = `LINE: ${card.fax}`;
    }
    card.fax = "";
  }
  if (card.fax && /^\d{8}$/.test(card.fax) && /統編|統一編號/.test(card.note)) {
    if (!card.note.includes(card.fax)) {
      card.note = [card.note, `統編：${card.fax}`].filter(Boolean).join("\n");
    }
    card.fax = "";
  }
  if (card.mobile && !isLikelyMobile(card.mobile)) {
    if (!card.fax) {
      card.fax = card.mobile;
    }
    card.mobile = "";
  }
  if (card.nameEn && !isLikelyEnglishPersonName(card.nameEn, [
    card.company,
    card.companyZh,
    card.companyEn,
    card.department,
    card.departmentZh,
    card.departmentEn,
  ])) {
    card.nameEn = "";
  }
  if (card.companyZh && isLikelyDepartment(card.companyZh) && !isLikelyChineseCompany(card.companyZh)) {
    if (!card.departmentZh) {
      card.departmentZh = card.companyZh;
    }
    card.companyZh = "";
  }
  if (card.departmentZh && isLikelyChineseCompany(card.departmentZh)) {
    if (!card.companyZh) {
      card.companyZh = card.departmentZh;
    }
    card.departmentZh = "";
  }
  if (card.titleZh && isLikelyChineseCompany(card.titleZh)) {
    if (!card.companyZh) {
      card.companyZh = card.titleZh;
    }
    card.titleZh = "";
  }
  if (card.titleZh && isLikelyDepartment(card.titleZh)) {
    if (!card.departmentZh) {
      card.departmentZh = card.titleZh;
    }
    card.titleZh = "";
  }
  if (card.departmentZh && isLikelyTitle(card.departmentZh)) {
    if (!card.titleZh) {
      card.titleZh = card.departmentZh;
    }
    card.departmentZh = "";
  }
  if (card.companyEn && isLikelyDepartment(card.companyEn) && !isLikelyEnglishCompany(card.companyEn)) {
    if (!card.departmentEn) {
      card.departmentEn = card.companyEn;
    }
    card.companyEn = "";
  }
  if (card.departmentEn && isLikelyEnglishCompany(card.departmentEn)) {
    if (!card.companyEn) {
      card.companyEn = card.departmentEn;
    }
    card.departmentEn = "";
  }
  if (card.departmentEn && isLikelyTitle(card.departmentEn)) {
    if (!card.titleEn) {
      card.titleEn = card.departmentEn;
    }
    card.departmentEn = "";
  }
  if (card.companyEn && isLongUnstructuredText(card.companyEn)) {
    card.companyEn = "";
  }
  if (card.addressZh && !isLikelyChineseAddress(card.addressZh)) {
    card.addressZh = "";
  }
  card.name = card.nameZh || card.nameEn || "";
  card.company = card.companyZh || card.companyEn || "";
  card.department = card.departmentZh || card.departmentEn || "";
  card.title = card.titleZh || card.titleEn || "";
}

function repairEnglishFieldsFromRawText(card: Required<CardPayload> & { rawText?: string }): void {
  const lines = recognitionTextLines(card.rawText || "")
    .filter((line) => !looksChineseLike(line))
    .filter((line) => !isEmail(line))
    .filter((line) => !isLikelyPhoneNumber(line))
    .filter((line) => !/\b(?:www\.|https?:\/\/|tel|fax|mobile|email|e-mail)\b/i.test(line));

  if (card.titleEn && isLikelyEnglishPersonName(card.titleEn, [card.companyEn, card.departmentEn])) {
    if (!card.nameEn) {
      card.nameEn = card.titleEn;
    }
    card.titleEn = "";
  }
  if (card.departmentEn && isLikelyEnglishCompany(card.departmentEn)) {
    if (!card.companyEn) {
      card.companyEn = card.departmentEn;
    }
    card.departmentEn = "";
  }

  const company = lines.find(isLikelyEnglishCompany);
  if ((!card.companyEn || (isLikelyDepartment(card.companyEn) && !isLikelyEnglishCompany(card.companyEn))) && company) {
    card.companyEn = company;
  }

  const companyCandidates = [card.company, card.companyZh, card.companyEn, company]
    .filter((value): value is string => Boolean(value));
  const name = findEnglishPersonName(lines, companyCandidates);
  if (!card.nameEn && name) {
    card.nameEn = name;
  }

  const department = lines.find((line) =>
    isLikelyDepartment(line)
    && !isLikelyEnglishCompany(line)
    && !isLikelyTitle(line)
  );
  if (!card.departmentEn && department) {
    card.departmentEn = department;
  }

  const title = lines.find((line) =>
    isLikelyTitle(line)
    && !isLikelyEnglishCompany(line)
    && !isLikelyDepartment(line)
  );
  if (!card.titleEn && title) {
    card.titleEn = title;
  }
}

function recognitionTextLines(rawText: string): string[] {
  const nested = rawText.match(/"rawText"\s*:\s*"((?:\\.|[^"])*)"/s)?.[1];
  const text = (nested || rawText)
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\//g, "/");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["'{[]+|[,"'}\]]+$/g, "").trim())
    .filter(Boolean);
}

function findEnglishPersonName(lines: string[], companyCandidates: string[]): string {
  return lines.find((line) =>
    isLikelyEnglishPersonName(line, companyCandidates)
    && !isLikelyEnglishCompany(line)
    && !isLikelyDepartment(line)
  ) || "";
}

function findSimpleEnglishName(lines: string[]): string {
  return lines.find((line) =>
    /^[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3}$/.test(line)
    && !isLikelyEnglishCompany(line)
    && !isLikelyDepartment(line)
  ) || "";
}

function findChinesePersonNameFromText(text: string, companyCandidates: string[]): string {
  const beforeContactMatch = text.match(/([\u3400-\u9fff·・]{2,4})(?=電話|手機|傳真|E-mail|Email|網址|統編)/);
  if (beforeContactMatch?.[1] && isLikelyChinesePersonName(beforeContactMatch[1], companyCandidates)) {
    return beforeContactMatch[1];
  }
  const beforePhone = text.split(/電話|手機|傳真|E-mail|Email|網址|統編/)[0] || text;
  const matches = beforePhone.match(/[\u3400-\u9fff·・]{2,4}/g) || [];
  for (const value of matches.reverse()) {
    if (isLikelyChinesePersonName(value, companyCandidates) && !isLikelyTitle(value) && !isLikelyDepartment(value)) {
      return value;
    }
  }
  return "";
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  const parts = local
    .split(/[._-]+/)
    .filter((part) => /^[A-Za-z]+$/.test(part));
  if (parts.length < 2 || parts.length > 4) {
    return "";
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function inferCompanyAndDepartment(card: Required<CardPayload>): void {
  if (card.companyZh && !card.departmentZh && isLikelyDepartment(card.companyZh) && !isLikelyChineseCompany(card.companyZh)) {
    card.departmentZh = card.companyZh;
    card.companyZh = "";
  }
  if (card.companyEn && !card.departmentEn && isLikelyDepartment(card.companyEn) && !isLikelyEnglishCompany(card.companyEn)) {
    card.departmentEn = card.companyEn;
    card.companyEn = "";
  }
}

function isLikelyChineseAddress(line: string): boolean {
  return /[\u3400-\u9fff]/.test(line)
    && /(?:\d{3,6}\s*)?(?:台|臺|新北|台北|臺北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江).*(?:市|縣)?.*(?:路|街|大道|段|巷|弄|號)/.test(line);
}

function hasMixedLanguageAddress(line: string): boolean {
  return looksChineseLike(line) && looksLatinLike(line) && isLikelyChineseAddress(line);
}

function extractChineseAddress(line: string): string {
  if (!isLikelyChineseAddress(line)) {
    return "";
  }
  const beforeEnglish = line
    .replace(/\d+F,?\s*No\..*$/i, "")
    .replace(/[A-Za-z]{2,}.*$/, "")
    .trim() || line.trim();
  const match = beforeEnglish.match(/(?:\d{3,6}\s*)?(?:台|臺|新北|台北|臺北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)[\u3400-\u9fff\d\s\-之、號樓室段巷弄路街大道縣市區鄉鎮]+/);
  return (match?.[0] || beforeEnglish).trim();
}

function normalizeChineseAddress(value: string): string {
  return value
    .replace(/^台北市西區/, "台中市西區")
    .replace(/^臺北市西區/, "臺中市西區");
}

function normalizeCommonOcrText(value: string): string {
  return value
    .replace(/^中國管理中心$/, "中區管理中心")
    .replace(/名集人/g, "召集人");
}

function isJunkField(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /"confidence"\s*:/.test(trimmed);
}

function findPhoneLine(lines: string[]): string {
  for (const line of lines) {
    if (!/^(?:T|Tel|電話|專線)\b|^(?:T|Tel|電話|專線)\s*[|:：]/i.test(line)) {
      continue;
    }
    const match = line.match(/(?:T|Tel|電話|專線)\s*(?:[|:：])?\s*([+()\d][+\d()\-\s]*(?:轉\s*\d+|ext\.?\s*\d+)?)/i);
    if (match?.[1]) {
      return match[1].replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function findFaxLine(lines: string[]): string {
  for (const line of lines) {
    if (!/(?:^|\s)(?:F|Fax)\b|傳真/i.test(line)) {
      continue;
    }
    const match = line.match(/(?:F|Fax|傳真)\s*(?:[|:：])?\s*([+()\d][+\d()\-\s]*(?:轉\s*\d+|ext\.?\s*\d+)?)/i);
    if (match?.[1]) {
      return match[1].replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function findWebsiteLine(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/(?:網址|Website|Web|URL)\s*[:：]?\s*(https?:\/\/[^\s]+|www\.[^\s]+)/i)
      || line.match(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/i);
    if (match?.[1] || match?.[0]) {
      return (match[1] || match[0]).trim();
    }
  }
  return "";
}

function findTaxIdLine(lines: string[]): string {
  const line = lines.find((value) => /統編|統一編號/.test(value));
  const match = line?.match(/(?:統編|統一編號)\s*[:：]?\s*(\d{8})/);
  return match?.[1] ? `統編：${match[1]}` : "";
}

function isLikelyEnglishCompany(line: string): boolean {
  return looksLatinLike(line)
    && !looksChineseLike(line)
    && (
      /\b(?:inc|ltd|limited|corp|corporation|company|foundation|association|council|holdings|branch|co\.?,?\s*ltd)\b/i.test(line)
      || /\b(?:patent|trademark)\b.*\b(?:office|firm|law)\b/i.test(line)
      || /\blaw\s+(?:office|firm)\b/i.test(line)
    );
}

function isLikelyChineseCompany(line: string): boolean {
  return looksChineseLike(line) && (/(公司|股份|有限|協會|基金會|法人|商會|公會|集團|發展會)$/.test(line) || /事務所/.test(line));
}

function isLikelyDepartment(line: string): boolean {
  return /(部門|事業部|中心|推廣中心|辦公室|處|組|課|室|部$|\bdepartment\b|\bdivision\b|\bcenter\b|\boffice\b|\bsection\b)/i.test(line);
}

function isLikelyTitle(line: string): boolean {
  return /(董事長|執行長|總經理|副總|經理|協理|主任|副處長|處長|專員|工程師|顧問|Chairman|Director|Manager|Specialist|Executive|Officer|Engineer|Consultant|Representative|PR Manager)/i.test(line);
}

function isEmail(line: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.trim());
}

function isLikelyMobile(value: string): boolean {
  const normalized = value.replace(/[\s\-()]/g, "");
  return /^09\d{8}$/.test(normalized) || /^\+?8869\d{8}$/.test(normalized);
}

function isLikelyPhoneNumber(value: string): boolean {
  return /(?:\+?\d[\d\s\-()#]{5,}\d)/.test(value.trim());
}

function isLongUnstructuredText(line: string): boolean {
  return line.trim().split(/\s+/).length > 10 || /\b(?:Tel|Fax|E-mail|Email)\b/i.test(line);
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[\s.,，。股份有限公司有限公司'’"“”()（）-]/g, "");
}

function emptyRecognition(): RecognitionResult {
  return {
    name: "",
    nameZh: "",
    nameEn: "",
    company: "",
    companyZh: "",
    companyEn: "",
    department: "",
    departmentZh: "",
    departmentEn: "",
    title: "",
    titleZh: "",
    titleEn: "",
    email: "",
    phone: "",
    mobile: "",
    fax: "",
    website: "",
    addressZh: "",
    addressEn: "",
    note: "",
    rawText: "",
    confidence: null,
  };
}

function normalizeLanguageFields<T extends Required<CardPayload>>(card: T): T {
  const next = { ...card };
  if (!next.nameEn && looksLatinLike(next.nameZh) && !looksChineseLike(next.nameZh)) {
    next.nameEn = next.nameZh;
  }
  if (!next.companyEn && looksLatinLike(next.companyZh) && !looksChineseLike(next.companyZh)) {
    next.companyEn = next.companyZh;
  }
  if (!next.departmentEn && looksLatinLike(next.departmentZh) && !looksChineseLike(next.departmentZh)) {
    next.departmentEn = next.departmentZh;
  }
  if (!next.titleEn && looksLatinLike(next.titleZh) && !looksChineseLike(next.titleZh)) {
    next.titleEn = next.titleZh;
  }

  next.nameZh = onlyChineseLike(next.nameZh);
  next.companyZh = onlyChineseLike(next.companyZh);
  next.departmentZh = onlyChineseLike(next.departmentZh);
  next.titleZh = onlyChineseLike(next.titleZh);
  next.addressZh = onlyChineseLike(next.addressZh);

  next.nameEn = onlyLatinLike(next.nameEn);
  next.companyEn = onlyLatinLike(next.companyEn);
  next.departmentEn = onlyLatinLike(next.departmentEn);
  next.titleEn = onlyLatinLike(next.titleEn);
  next.addressEn = onlyLatinAddress(next.addressEn);

  if (!next.nameZh && looksChineseLike(next.name)) {
    next.nameZh = next.name;
  }
  if (!next.nameEn && looksLatinLike(next.name)) {
    next.nameEn = next.name;
  }
  if (!next.companyZh && looksChineseLike(next.company)) {
    next.companyZh = next.company;
  }
  if (!next.companyEn && looksLatinLike(next.company)) {
    next.companyEn = next.company;
  }
  if (!next.departmentZh && looksChineseLike(next.department)) {
    next.departmentZh = next.department;
  }
  if (!next.departmentEn && looksLatinLike(next.department)) {
    next.departmentEn = next.department;
  }
  if (!next.titleZh && looksChineseLike(next.title)) {
    next.titleZh = next.title;
  }
  if (!next.titleEn && looksLatinLike(next.title)) {
    next.titleEn = next.title;
  }

  return next;
}

function onlyChineseLike(value: string): string {
  return looksChineseLike(value) ? value : "";
}

function onlyLatinLike(value: string): string {
  return value && looksLatinLike(value) && !looksChineseLike(value) ? value : "";
}

function onlyLatinAddress(value: string): string {
  return value && !looksChineseLike(value) ? value : "";
}

function looksChineseLike(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function looksLatinLike(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

function prefer(primary: string, fallback: string): string {
  return primary || fallback || "";
}

function averageConfidence(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((value): value is number => typeof value === "number");
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aiResponseText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }
  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  const openAiText = openAiChatResponseText(record);
  if (openAiText) {
    return openAiText;
  }
  for (const key of ["response", "result", "text", "output_text"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(response);
}

function openAiChatResponseText(record: Record<string, unknown>): string {
  const choices = record.choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      continue;
    }
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    for (const key of ["content", "reasoning", "reasoning_content"]) {
      const value = messageRecord[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      if (Array.isArray(value)) {
        const text = value
          .map((part) => part && typeof part === "object"
            ? asString((part as Record<string, unknown>).text)
            : "")
          .filter(Boolean)
          .join("\n");
        if (text) {
          return text;
        }
      }
    }
  }
  return "";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (!cause || typeof cause !== "object") {
    return "";
  }
  const record = cause as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (value && typeof value === "object") {
      const nested = errorMessage(value);
      if (nested) {
        return nested;
      }
    }
  }
  return JSON.stringify(cause);
}

function cleanAiField(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\*\*/g, "")
    .replace(/^(?:Name|NameZh|NameEn|Company|CompanyZh|CompanyEn|Department|DepartmentZh|DepartmentEn|Title|TitleZh|TitleEn|Email|Phone|Mobile|Fax|Website|AddressZh|AddressEn|Note|RawText|Confidence)\s*:\s*/i, "")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/暁/g, "曉")
    .trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? cleanAiField(value) : "";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function safeFileName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return cleaned || "image.jpg";
}

function imageUrl(cardId: string, side: ImageSide, version?: string): string {
  const path = `/api/cards/${cardId}/images/${side}`;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}
