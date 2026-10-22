import { getCurrentMember } from "@/lib/auth-server";

export default async function ProfilePage() {
  const result = await getCurrentMember();
  if (!result.ok) return null;
  const member = result.data;

  return (
    <>
      <h1>내 정보</h1>
      <dl>
        <dt>이름</dt>
        <dd>{member.displayName}</dd>
        <dt>아이디</dt>
        <dd>{member.username}</dd>
      </dl>
    </>
  );
}
