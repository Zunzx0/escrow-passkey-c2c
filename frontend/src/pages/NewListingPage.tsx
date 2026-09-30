import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createListing } from "../api/listings";
import { ApiError } from "../api/client";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Alert } from "../components/ui/Alert";

const inputClass =
  "mt-1.5 w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[var(--color-text)] transition-colors placeholder:text-[var(--color-text-light)] focus:border-[var(--color-brand)] focus:outline-none focus:ring-2 focus:ring-[rgba(14,165,233,0.15)]";

const labelClass = "block text-sm font-medium text-[var(--color-text)]";

export default function NewListingPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [imageUrls, setImageUrls] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const priceNumber = Number(price);
    if (!Number.isInteger(priceNumber) || priceNumber <= 0) {
      setError("Giá phải là số nguyên dương (đơn vị VNĐ).");
      return;
    }

    setLoading(true);
    try {
      const listing = await createListing({
        title,
        description: description || undefined,
        price: priceNumber,
        imageUrls: imageUrls
          .split(/[\n,]/)
          .map((u) => u.trim())
          .filter(Boolean),
      });
      navigate(`/listings/${listing.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không thể đăng tin.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold text-[var(--color-text)]">Đăng tin bán</h1>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Mỗi tin đăng là một món đồ đơn chiếc — không quản lý theo số lượng/tồn kho.</p>

      <Card className="mt-6 p-6">
        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className={labelClass} htmlFor="title">
              Tên món đồ
            </label>
            <input
              id="title"
              required
              maxLength={200}
              placeholder="VD: iPhone 15 Pro 256GB"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="description">
              Mô tả tình trạng
            </label>
            <textarea
              id="description"
              rows={4}
              placeholder="Mô tả càng rõ, người mua càng yên tâm: tình trạng, phụ kiện kèm theo, lý do bán…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="price">
              Giá bán (VNĐ)
            </label>
            <input
              id="price"
              type="number"
              min={1}
              step={1}
              required
              placeholder="11500000"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="imageUrls">
              Ảnh (mỗi URL một dòng, tuỳ chọn)
            </label>
            <textarea
              id="imageUrls"
              rows={3}
              placeholder="https://..."
              value={imageUrls}
              onChange={(e) => setImageUrls(e.target.value)}
              className={inputClass}
            />
          </div>
          <Button type="submit" variant="gradient" className="h-12 w-full" loading={loading}>
            Đăng tin
          </Button>
        </form>
      </Card>
    </div>
  );
}
