begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

-- goals.map_level records the level the worker built the map for. It is
-- nullable, limited to the three levels, and never user-writable.
select has_column('public', 'goals', 'map_level', 'goals.map_level exists');
select col_is_null('public', 'goals', 'map_level', 'goals.map_level is nullable');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into public.goals (id, user_id, title)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'A goal');

select throws_ok($$update public.goals set map_level = 'expert' where id = '10000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'map_level rejects values outside the three levels');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select throws_ok($$update public.goals set map_level = 'advanced' where id = '10000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'map_level is not user-writable');
select is((select map_level from public.goals where id = '10000000-0000-0000-0000-00000000000a'),
  null, 'map_level is readable by the owner and starts null');

select * from finish();
rollback;
