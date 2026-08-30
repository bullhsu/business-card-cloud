create table if not exists google_tokens (
  id text primary key,
  access_token text not null default '',
  refresh_token text not null default '',
  expires_at integer not null default 0,
  scope text not null default '',
  token_type text not null default 'Bearer',
  updated_at text not null
);

create table if not exists google_oauth_states (
  state text primary key,
  redirect_path text not null default '/',
  created_at text not null
);
