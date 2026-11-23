// ffmpeg / ffprobe / 通用子进程封装：进度解析、可中止。
const { spawn, execFile } = require('child_process');
const { paths } = require('./paths.cjs');

// 放进 -vf 滤镜参数里的文件路径：统一用 /，冒号和引号转义，再整体加单引号
function filterPath(p) {
  return "'" + String(p).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') + "'";
}

// Windows 上程序异常退出时的退出码（十进制很难认），翻译成能看懂的话
const WIN_CRASH = {
  3221225477: '程序崩溃（访问了无效内存）',
  3221225781: '缺少运行库（DLL）',
  3221225786: '被强行终止',
  3221226505: '程序崩溃',
  3221225725: '程序崩溃（栈溢出）',
};

// Windows 上 kill 只杀得掉进程本身，它开的子进程（比如口型脚本开的 ffmpeg）会留下，所以连同子进程一起结束
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  }
}

// stdinFile：把这个文件的内容喂给子进程的标准输入（用来绕开子进程不认中文路径的问题）
function runProcess(cmd, args, { signal, onStdout, onStderr, cwd, env, stdinFile } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'));
    const child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true });
    let stderrTail = '';
    let settled = false;
    let graceTimer = null;
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (stdinFile) {
      const rs = require('fs').createReadStream(stdinFile);
      rs.on('error', () => child.stdin.destroy());
      child.stdin.on('error', () => {}); // 子进程提前退出时写入会报 EPIPE，由退出码说明原因
      rs.pipe(child.stdin);
    }
    child.stdout.on('data', (d) => onStdout?.(d.toString()));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      onStderr?.(s);
    });
    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('已取消'));
      if (code === 0) return resolve();
      const why = WIN_CRASH[code] ? `${WIN_CRASH[code]}（退出码 ${code}）` : code === null ? `被终止（${sig || '未知信号'}）` : `退出码 ${code}`;
      reject(new Error(`${require('path').basename(cmd)} ${why}\n${stderrTail.trim().split(/\r?\n/).slice(-6).join('\n')}`));
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    // 正常以 close（输出管道都关了）为准，这样不会丢最后几行输出。
    // 但进程已经退出、它开的子进程还占着输出管道时 close 一直不来，任务会永远显示「运行中」，所以退出 5 秒后强制收尾。
    child.on('exit', (code, sig) => {
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, sig);
      }, 5000);
    });
    child.on('close', finish);
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      paths.ffprobe() || 'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('无法读取媒体信息：' + file));
        const j = JSON.parse(stdout);
        const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
        const a = j.streams.find((s) => s.codec_type === 'audio');
        let width = v?.width || 0;
        let height = v?.height || 0;
        // 手机竖拍视频可能带旋转元数据
        const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((x) => x.rotation != null)?.rotation || 0);
        if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
        const fpsParts = (v?.avg_frame_rate || '0/1').split('/');
        resolve({
          duration: Number(j.format?.duration || v?.duration || a?.duration || 0),
          width,
          height,
          fps: Number(fpsParts[0]) / Number(fpsParts[1] || 1) || 25,
          hasVideo: !!v,
          hasAudio: !!a,
          audioCodec: a?.codec_name,
          size: Number(j.format?.size || 0),
        });
      }
    );
  });
}

// 跑 ffmpeg，并按输出时长回报 0~1 进度
function ffmpeg(args, { duration, onProgress, signal, cwd } = {}) {
  const full = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args];
  let buf = '';
  return runProcess(paths.ffmpeg() || 'ffmpeg', full, {
    signal,
    cwd,
    onStdout: (s) => {
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && duration > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    },
  });
}

// ---------- 硬件编码检测 ----------
// Mac 用 VideoToolbox；Windows 依次试 NVIDIA / Intel / AMD。ffmpeg 里「有这个编码器」不代表机器上能用，
// 所以用和正式编码一样的参数真的编一小段，成功才算。结果缓存，检测完成前按 CPU（x264）编码。
const HW_CANDIDATES =
  process.platform === 'darwin'
    ? [{ name: 'videotoolbox', label: 'Apple 硬件编码', args: (crf) => ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(30, Math.min(85, Math.round(110 - crf * 2.5)))), '-pix_fmt', 'yuv420p', '-allow_sw', '1'] }]
    : process.platform === 'win32'
      ? [
          { name: 'nvenc', label: 'NVIDIA 硬件编码', args: (crf) => ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf + 1), '-b:v', '0', '-pix_fmt', 'yuv420p'] },
          { name: 'qsv', label: 'Intel 硬件编码', args: (crf) => ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(crf + 1), '-pix_fmt', 'nv12'] },
          { name: 'amf', label: 'AMD 硬件编码', args: (crf) => ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2), '-pix_fmt', 'yuv420p'] },
        ]
      : [];
let hw = null; // 检测到的硬件编码器
let hwPromise = null;
function detectHwEncoder() {
  if (hwPromise) return hwPromise;
  hwPromise = (async () => {
    const ff = paths.ffmpeg();
    if (!ff) return null;
    for (const c of HW_CANDIDATES) {
      try {
        await runProcess(ff, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.3', ...c.args(20), '-f', 'null', '-'], {});
        hw = c;
        return c;
      } catch {}
    }
    return null;
  })();
  return hwPromise;
}
const hwEncoder = () => hw;
const x264Args = (crf, preset = 'medium') => ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];

module.exports = { runProcess, probe, ffmpeg, filterPath, detectHwEncoder, hwEncoder, x264Args };
