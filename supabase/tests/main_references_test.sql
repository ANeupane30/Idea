begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000008a0', 'ma@example.com'),
  ('00000000-0000-0000-0000-0000000008b0', 'mb@example.com');
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000008a0', 'A', 'ready');
insert into public.contents (content_hash, type, token_count, embed_model) values ('h-main', 'pdf', 10, 'fake');
insert into public.source_chunks (id, content_hash, position, text, token_count, embedding, page)
values ('40000000-0000-0000-0000-0000000008a1', 'h-main', 0, 'x', 1, array_fill(0, array[384])::extensions.vector, 4);
insert into public.sources (id, goal_id, user_id, type, url_or_file, file_name, title, content_hash, status)
values ('30000000-0000-0000-0000-0000000008a1', '10000000-0000-0000-0000-0000000008a1',
        '00000000-0000-0000-0000-0000000008a0', 'pdf', '00000000-0000-0000-0000-0000000008a0/11111111-1111-1111-1111-111111111111.pdf',
        'book.pdf', 'The book', 'h-main', 'ready');
insert into public.subtopics (id, goal_id, title, position, primary_ref) values
  ('20000000-0000-0000-0000-0000000008a1', '10000000-0000-0000-0000-0000000008a1', 'Ch 1', 0,
   '40000000-0000-0000-0000-0000000008a1'),
  ('20000000-0000-0000-0000-0000000008a2', '10000000-0000-0000-0000-0000000008a1', 'Ch 2', 1, null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000008a0"}';
select is(
  (select count(*) from public.goal_main_references('10000000-0000-0000-0000-0000000008a1')),
  1::bigint, 'one row per topic with a main reference');
select is(
  (select source_title || '|' || source_type || '|' || page::text from public.goal_main_references('10000000-0000-0000-0000-0000000008a1')
   where subtopic_id = '20000000-0000-0000-0000-0000000008a1'),
  'The book|pdf|4', 'the source title, type and the chunk''s page');
select throws_ok($$select * from public.contents$$, '42501', null, 'chunks stay unreadable directly');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000008b0"}';
select is(
  (select count(*) from public.goal_main_references('10000000-0000-0000-0000-0000000008a1')),
  0::bigint, 'another user sees nothing');

select * from finish();
rollback;
