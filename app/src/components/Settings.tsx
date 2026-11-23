import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { api, useSettings, refreshEnv, Env, fmtSize, IS_WIN } from '../api';
import { Toggle, toast } from './ui';

const DIRS: [string, string, string][] = [
  ['burn', '字幕烧录输出', '留空 = 总目录下的「字幕输出」'],
  ['mp3', '音频提取输出', '留空 = 总目录下的「MP3输出」'],
  ['text', '转文字输出', '留空 = 总目录下的「转文字输出」'],
  ['lipsync', '数字人输出', '成品带字幕；不带字幕的原片在 _原片 子目录'],
  ['avatars', '数字人形象库', '形象副本和人脸分析缓存，每个形象约几百 MB'],
  ['collect', '采集中心下载', '留空 = 总目录下的「采集中心下载」'],
  ['tts', 'AI 配音输出', '留空 = 总目录下的「配音输出」；每条配音有 MP3、同名 SRT 和逐字时间戳'],
];

export default function Settings({ onClose }: { onClose: () => void }) {
  const [saved, save] = useSettings();
  const [s, setS] = useState<any>(saved);
  const [env, setEnv] = useState<Env | null>(null);
  useEffect(() => setS(saved), [saved]);
  if (!s) return null;
  const set = (sec: string, patch: any) => setS({ ...s, [sec]: { ...s[sec], ...patch } });

  const pickDir = async (cb: (d: string) => void) => {
    const d = await api.dialog.pickDir();
    if (d) cb(d);
  };
  const check = async () => {
    setEnv(await refreshEnv());
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          设置
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">保存位置</div>
          <div className="set-row">
            <label>总目录</label>
            <div>
              <div className="row">
                <input className="input grow" value={s.outRoot} onChange={(e) => setS({ ...s, outRoot: e.target.value })} />
                <button className="btn sm" onClick={() => pickDir((d) => setS({ ...s, outRoot: d }))}>
                  <FolderOpen size={13} /> 浏览
                </button>
                <button className="btn ghost sm" onClick={() => api.shell.open(s.outRoot)}>
                  打开
                </button>
              </div>
              <div className="desc">各模块默认在这里建自己的子文件夹（字幕输出、MP3输出、转文字输出……），也可以在下面单独指定。</div>
            </div>
          </div>
          {DIRS.map(([k, label, desc]) => (
            <div className="set-row" key={k}>
              <label>{label}</label>
              <div>
                <div className="row">
                  <input className="input grow" placeholder="留空使用默认" value={s.dirs[k]} onChange={(e) => set('dirs', { [k]: e.target.value })} />
                  <button className="btn sm" onClick={() => pickDir((d) => set('dirs', { [k]: d }))}>
                    浏览
                  </button>
                  <button className="btn ghost sm" onClick={async () => api.shell.open(await api.settings.dirOf(k))}>
                    打开
                  </button>
                  <button className="btn ghost sm" onClick={() => set('dirs', { [k]: '' })}>
                    清空
                  </button>
                </div>
                <div className="desc">{desc}</div>
              </div>
            </div>
          ))}

          <div className="set-group">输出</div>
          <div className="set-row">
            <label>文件名后缀</label>
            <div>
              <input className="input" value={s.output.suffix} onChange={(e) => set('output', { suffix: e.target.value })} />
              <div className="desc">字幕烧录成品 = 原名 + 后缀.mp4</div>
            </div>
          </div>
          <div className="set-row">
            <label>跳过已完成</label>
            <div>
              <Toggle on={s.output.skipDone} onChange={(v) => set('output', { skipDone: v })} />
              <div className="desc">输出文件已经存在时不重复处理</div>
            </div>
          </div>
          <div className="set-row">
            <label>输出文件加序号</label>
            <div>
              <Toggle on={s.output.addSeq} onChange={(v) => set('output', { addSeq: v })} />
              <div className="desc">按列表顺序给成品加 001_、002_ 前缀，谁先做完都不影响顺序</div>
            </div>
          </div>
          <div className="set-row">
            <label>烧录后删除原视频</label>
            <div>
              <Toggle on={s.output.deleteSource} onChange={(v) => set('output', { deleteSource: v })} />
              <div className="desc">成品生成成功后把原视频移到废纸篓（可以从废纸篓找回）</div>
            </div>
          </div>

          <div className="set-group">语音识别</div>
          <div className="set-row">
            <label>识别语言</label>
            <div>
              <select className="input" value={s.asr.language} onChange={(e) => set('asr', { language: e.target.value })}>
                <option value="zh">中文 (zh)</option>
                <option value="en">英文 (en)</option>
                <option value="ja">日文 (ja)</option>
                <option value="auto">自动检测 (auto)</option>
              </select>
            </div>
          </div>
          <div className="set-row">
            <label>识别引擎</label>
            <div>
              <select className="input" value={s.asr.engine || 'auto'} onChange={(e) => set('asr', { engine: e.target.value })}>
                <option value="auto">自动（有快速识别就用，快很多）</option>
                <option value="whisper">Whisper（慢，支持的语言多）</option>
              </select>
              <div className="desc">
                快速识别用的是 SenseVoice 小模型：不用显卡，速度比 Whisper 快很多，支持中文、英文、日文。
                {env && !env.senseVoice && ' 这台电脑上没装快速识别，现在用的是 Whisper。'}
              </div>
            </div>
          </div>
          <div className="set-row">
            <label>模型文件</label>
            <div>
              <div className="row">
                <input className="input grow" placeholder="留空使用内置 large-v3-turbo" value={s.asr.model} onChange={(e) => set('asr', { model: e.target.value })} />
              </div>
              <div className="desc">Whisper 用的 ggml 模型文件路径，一般不用改</div>
            </div>
          </div>
          <div className="set-row">
            <label>每行字幕最多字数</label>
            <div>
              <input className="input" type="number" min={6} max={30} value={s.asr.maxChars} onChange={(e) => set('asr', { maxChars: +e.target.value })} />
              <div className="desc">竖屏建议 12~16，横屏可以 20 左右</div>
            </div>
          </div>
          <div className="set-row">
            <label>使用同名字幕文件</label>
            <div>
              <Toggle on={s.asr.useSameNameSrt} onChange={(v) => set('asr', { useSameNameSrt: v })} />
              <div className="desc">打开后，视频旁边有同名 .srt 时直接用它、不再识别。只在你自己准备了字幕文件时打开</div>
            </div>
          </div>
          <div className="set-row">
            <label>CPU 线程 / 同时识别</label>
            <div className="row">
              <input className="input" type="number" min={1} max={16} value={s.asr.threads} onChange={(e) => set('asr', { threads: +e.target.value })} style={{ width: 80 }} />
              <input className="input" type="number" min={1} max={4} value={s.asr.concurrency} onChange={(e) => set('asr', { concurrency: +e.target.value })} style={{ width: 80 }} />
            </div>
          </div>

          <div className="set-group">视频编码</div>
          <div className="set-row">
            <label>编码器</label>
            <div>
              <select className="input" value={s.encode.encoder} onChange={(e) => set('encode', { encoder: e.target.value })}>
                <option value="auto">自动（有显卡/芯片硬件编码就用，快）{env?.gpuEncodeName ? `：${env.gpuEncodeName}` : ''}</option>
                <option value="x264">x264 软件编码（慢，同码率更清晰）</option>
              </select>
            </div>
          </div>
          <div className="set-row">
            <label>画质</label>
            <div>
              <input className="input" type="number" min={14} max={30} value={s.encode.quality} onChange={(e) => set('encode', { quality: +e.target.value })} style={{ width: 80 }} />
              <div className="desc">数值越小画质越高，推荐 18~23</div>
            </div>
          </div>
          <div className="set-row">
            <label>同时烧录数</label>
            <div>
              <input className="input" type="number" min={1} max={6} value={s.encode.burnConcurrency} onChange={(e) => set('encode', { burnConcurrency: +e.target.value })} style={{ width: 80 }} />
            </div>
          </div>

          <div className="set-group">数字人</div>
          <div className="set-row">
            <label>同时生成数量</label>
            <div>
              <input className="input" type="number" min={1} max={3} value={s.lipsync.concurrency} onChange={(e) => set('lipsync', { concurrency: +e.target.value })} style={{ width: 80 }} />
              <div className="desc">建议 1；多开会抢 GPU，不一定更快</div>
            </div>
          </div>
          <div className="set-row">
            <label>快速模式</label>
            <div>
              <Toggle on={!!s.lipsync.fastDecode} onChange={(v) => set('lipsync', { fastDecode: v })} />
              <div className="desc">用小型解码模型生成嘴部画面，速度明显更快，嘴部细节（牙齿、唇纹）会略软一点。先用同一段素材开/关各生成一条对比，能接受再常开</div>
            </div>
          </div>
          <div className="set-row">
            <label>嘴部区域偏移</label>
            <div>
              <input className="input" type="number" min={-20} max={20} value={s.lipsync.bboxShift} onChange={(e) => set('lipsync', { bboxShift: +e.target.value })} style={{ width: 80 }} />
              <div className="desc">口型张合幅度不对时微调：正数往下（嘴张得更开），负数往上。改了之后已有形象会重新分析</div>
            </div>
          </div>

          {env && (
            <>
              <div className="set-group">环境检测结果</div>
              <div className="card small" style={{ lineHeight: 2 }}>
                {[
                  ['ffmpeg', env.ffmpeg],
                  [env.gpuEncodeName || '硬件编码（没有就用 CPU）', env.gpuEncode],
                  ['whisper-cli', env.whisper],
                  ['识别模型', env.whisperModel],
                  ...(env.senseVoice || IS_WIN ? [['快速识别（SenseVoice）', !!env.senseVoice]] : []),
                  ['数字人 Python 环境', env.lipsync.python],
                  ['数字人模型权重', env.lipsync.weights],
                  ['数字人口型脚本', env.lipsync.runner],
                  ...(IS_WIN ? [[env.gpu?.nvidia ? `NVIDIA 显卡：${env.gpu.name}` : 'NVIDIA 显卡（没有的话数字人用 CPU，非常慢）', !!env.gpu?.nvidia]] : []),
                ].map(([n, ok]) => (
                  <div key={n as string} className="row">
                    <span className={'dot ' + (ok ? 'ok' : 'bad')} />
                    {n} {ok ? '' : <span className="c-red">缺失</span>}
                  </div>
                ))}
                <div className="muted">
                  {env.chip} · {env.memGB} GB 内存 · 输出盘剩余 {env.disk ? fmtSize(env.disk) : '未知'}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={check}>
            检测环境
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await save(s);
              refreshEnv();
              toast('设置已保存');
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
