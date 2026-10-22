export function money(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
  }).format(amount);
}

export function kst(value: string) {
  return (
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      dateStyle: "short",
      timeStyle: "medium",
      hour12: false,
    }).format(new Date(value)) + " KST"
  );
}

export function queryText(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}
