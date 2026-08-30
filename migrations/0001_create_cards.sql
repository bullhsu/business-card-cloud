create table if not exists cards (
  id text primary key,
  display_name text not null default '',
  company text not null default '',
  title text not null default '',
  email text not null default '',
  phone text not null default '',
  website text not null default '',
  note text not null default '',
  front_image_key text not null,
  back_image_key text not null,
  front_image_url text not null,
  back_image_url text not null,
  google_label text not null default '工作聯絡人',
  google_contact_resource_name text,
  google_sync_status text not null default 'pending',
  google_sync_error text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_cards_email on cards(email);
create index if not exists idx_cards_phone on cards(phone);
create index if not exists idx_cards_google_sync_status on cards(google_sync_status);
