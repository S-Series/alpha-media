import PreviewNotice from "@/components/screens/preview-notice";
import OrderTable from "@/components/screens/order-table";
import { previewOrders } from "@/lib/preview-data";

export default function OrdersPage() {
  return (
    <>
      <h1>주문 내역</h1>
      <PreviewNotice />
      <OrderTable orders={previewOrders} />
    </>
  );
}
