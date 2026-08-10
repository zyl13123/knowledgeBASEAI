'use client'
import { useRef, useState } from 'react'

export function UploadZone({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function handleFile(file: File) {
    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,          // 注意：不要手写 Content-Type，让浏览器自动带 boundary
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert('上传失败: ' + (data.error || '未知错误'))
      }
    } catch (err) {
      alert('上传失败: ' + (err instanceof Error ? err.message : '网络错误'))
    } finally {
      setUploading(false)
      onUploaded()               // 通知父组件刷新列表
    }
  }

  return (
    <div onClick={() => inputRef.current?.click()}>
      {uploading ? '上传中...' : '拖拽或点击上传文档'}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
        }}
      />
    </div>
  )
}
