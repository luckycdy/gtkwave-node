import fs from 'fs'
import { binarySearch } from './search'
import { Redis } from 'ioredis'
interface RecursiveRecord<T> {
  [key: string]: T | RecursiveRecord<T>
}
interface HeaderObjProps {
  // 存放非信号相关键值对，如 date/version 等
  key: string
  value: string
  // 遍历是否已经过关键字
  alreadyKeyword: boolean
  // header 是否遍历结束
  headerClose: boolean
  header: {
    // Modules 存放每层的 Module， signalsOfModule 存放每个 Module 下的 Signals
    modules: RecursiveRecord<Record<string, never>>
    signalsOfModule: Record<string, string[]>
  }
  // 依次存放遍历到的 moduleName
  moduleStack: string[]
}
interface SignalsObjProps {
  valueChange: string
  alreadyKeyword: boolean
  // time 下数据，时间为键，值为 valueChange 键值对
  timeData: Record<number, Record<string, string>>
  currentTime?: number
}
type TimeData = SignalsObjProps['timeData']
type Header = HeaderObjProps['header']

class VCDParse {
  declarationKey: Set<string>
  dumpKey: Set<string>
  path: string
  redis: Redis

  constructor(path: string) {
    this.declarationKey = new Set([
      '$comment',
      '$date',
      '$enddefinitions',
      '$scope',
      '$timescale',
      '$upscope',
      '$var',
      '$version',
    ])
    this.dumpKey = new Set([
      '$dumpvars',
      '$dumpon',
      '$dumpall',
      '$dumpoff',
      '$end',
    ])
    this.path = path
    this.redis = new Redis({ password: 'test123' })
  }

  // 解析整个文件的时间刻度，存入 redis
  // todo any
  async parseSacle(
    callback: (scale: {
      timeScale: number[]
      timeIndex: number[]
    }) => Promise<TimeData>
  ): Promise<TimeData> {
    // timeSacle 与 timeIndex 一一对应，scale 存放时间刻度，index 存放该刻度对应的起始文件位置
    const rs = fs.createReadStream(this.path, { highWaterMark: 256 * 1024 }),
      timeScale: number[] = [],
      timeIndex: number[] = []
    // pastLen 记录之前的 chunk 总长度，curLen 记录当前 time 所在文件位置
    let timeStr = '',
      alreadyKeyword = false,
      pastLen = 0,
      curLen = 0
    console.time('t')
    rs.on('data', (chunk: Buffer) => {
      const len = chunk.length
      for (let i = 0; i < len; i++) {
        if (alreadyKeyword) {
          // 换行且 key 值不为空则捕获到时间刻度
          if (chunk[i] === 10 && timeStr) {
            timeScale.push(Number(timeStr))
            timeIndex.push(curLen)
            timeStr = ''
            alreadyKeyword = false
            break
          }
          // 0-9 之间则 key 增加，否则重置
          if (48 <= chunk[i] && chunk[i] <= 57)
            timeStr += String.fromCharCode(chunk[i])
          else {
            timeStr = ''
            alreadyKeyword = false
          }
        }
        // 等于 # 则找到 time 值
        else if (chunk[i] === 35) {
          alreadyKeyword = true
          curLen = i + pastLen
        }
      }
      pastLen += len
    })
    // 返回 promise 供异步处理 signals
    return new Promise((resolve, reject) => {
      rs.on('end', async () => {
        await this.redis.set(
          this.path,
          JSON.stringify({ timeScale, timeIndex })
        )
        console.timeEnd('t')
        const signals = await callback({ timeScale, timeIndex })
        try {
          resolve(signals)
        } catch (err) {
          reject(err)
        }
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
  }

  async parseSignals(t: number): Promise<TimeData> {
    // 定义回调函数，用作解析完 scale 后调用
    const cb = async (scale: {
      timeScale: number[]
      timeIndex: number[]
    }): Promise<TimeData> => {
      const midT = binarySearch(scale.timeScale, t),
        start = scale.timeIndex[Math.max(midT - 1, 0)],
        end =
          midT + 2 >= scale.timeScale.length
            ? Infinity
            : scale.timeIndex[midT + 2]
      // 只读取一小段 signals
      const rs = fs.createReadStream(this.path, { start, end })
      const signalsObj: SignalsObjProps = {
        valueChange: '',
        alreadyKeyword: false,
        timeData: {},
      }
      console.time('signal')
      rs.on('data', (chunk) => {
        this.#parseSignals(chunk.toString(), signalsObj)
      })
      // 返回异步处理后的 timeData
      return new Promise((resolve, reject) => {
        rs.on('close', () => {
          console.timeEnd('signal')
          resolve(signalsObj.timeData)
        })
        rs.on('error', (err) => {
          reject(err)
        })
      })
    }
    // 如果该文件时间刻度已存入 redis，则直接使用
    const scale = JSON.parse((await this.redis.get(this.path)) as string)
    if (scale !== null) {
      console.log('redis is not null')
      return cb(scale)
    } else {
      return await this.parseSacle(cb)
    }
  }

  async parseHeader(): Promise<Header> {
    const rs = fs.createReadStream(this.path)
    const headerObj: HeaderObjProps = {
      header: {
        modules: {},
        signalsOfModule: {},
      },
      key: '',
      value: '',
      alreadyKeyword: false,
      moduleStack: [],
      headerClose: false,
    }
    console.time('t')
    // 使用 promise 完成异步，关闭时再传出 header
    return new Promise((resolve, reject) => {
      rs.on('data', (chunk) => {
        this.#parseHeader(chunk.toString(), headerObj)
        if (headerObj.headerClose) rs.close()
      })
      rs.on('close', () => {
        resolve(headerObj.header)
        console.timeEnd('t')
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
  }

  #parseHeader(chunkString: string, headerObj: HeaderObjProps) {
    // todo scope 类型待完善 类型判断不完整，未做错误处理
    const header = headerObj.header,
      moduleStack = headerObj.moduleStack
    let index = 0
    // 循环当前 ChunkString
    while (index < chunkString.length) {
      if (headerObj.value.endsWith('$end')) {
        // enddefinitions 结束头部信息区域
        if (headerObj.key === '$enddefinitions') {
          index++
          headerObj.headerClose = true
          break
        } else if (headerObj.key === '$scope') {
          const moduleName = headerObj.value
            .slice(7, headerObj.value.length - 4)
            .trim()
          // moduleStack 存放 moduleName
          moduleStack.push(moduleName)
          // 初始化 signalsOfModule 和 modules 中对应 moduleName 值
          header.signalsOfModule[moduleName] = []
          header.modules[moduleName] = {}
        } else if (headerObj.key === '$var') {
          const signalSplit = headerObj.value
            .slice(0, headerObj.value.length - 4)
            .trim()
            .split(' ')
          // 将 signal 值存入 signalsOfModule 对应键中
          header.signalsOfModule[moduleStack[moduleStack.length - 1]].push(
            signalSplit[0] +
              ' ' +
              signalSplit[2] +
              ' ' +
              signalSplit[3] +
              (signalSplit[1] === '1'
                ? ''
                : `[${Number(signalSplit[1]) - 1}:0]`)
          )
        } else if (headerObj.key === '$upscope') {
          // 当前 module 统计完毕，出栈
          const moduleCur = moduleStack.pop()
          const len = moduleStack.length - 1
          if (len >= 0 && moduleCur) {
            // 当前出栈 module 为栈顶 module 的子 module
            header.modules[moduleStack[len]][moduleCur] =
              header.modules[moduleCur]
            // moduleCur 已变成子 module，可删除之前的多余的设置
            Reflect.deleteProperty(header.modules, moduleCur)
          }
        }
        // 存储普通的的 key value 键值对，如 version、 scale 等
        else {
          header[headerObj.key.slice(1)] = headerObj.value
            .slice(0, headerObj.value.length - 4)
            .trim()
        }
        // 每一轮 end 结束，重置 key value 再重新找关键字
        headerObj.key = ''
        headerObj.value = ''
        headerObj.alreadyKeyword = false
      }
      // 遇到换行或者在已有 keyword 情况下遇到空格，直接跳过继续遍历
      if (
        chunkString[index] === '\n' ||
        (chunkString[index] === ' ' && !headerObj.alreadyKeyword)
      ) {
        index++
        continue
      }
      // 使用 alreadyKeyword 决定当前字符为 key 还是 value
      if (headerObj.alreadyKeyword) headerObj.value += chunkString[index]
      else headerObj.key += chunkString[index]
      // 是否经过关键字
      if (!headerObj.alreadyKeyword && this.declarationKey.has(headerObj.key)) {
        headerObj.alreadyKeyword = true
      }
      index++
    }
  }

  #parseSignals(chunkString: string, signalsObj: SignalsObjProps) {
    const timeData = signalsObj.timeData
    let index = 0
    while (index < chunkString.length) {
      // 一行到底，开始匹配
      if (chunkString[index] === '\n') {
        signalsObj.valueChange = signalsObj.valueChange.trim()
        const tMatches = /^#(\d+)$/g.exec(signalsObj.valueChange)
        if (tMatches) {
          // 为 time 则把 time 存入键
          signalsObj.currentTime = parseInt(tMatches[1])
          timeData[signalsObj.currentTime] = {}
          // 遇到 dump 关键字则跳过
        } else if (this.dumpKey.has(signalsObj.valueChange)) {
          signalsObj.valueChange = ''
          continue
        }
        // 否则即匹配 valueChange 情况
        else {
          if (
            signalsObj.valueChange.startsWith('b') ||
            signalsObj.valueChange.startsWith('B')
          ) {
            // b 类型
            const vMatches = /^[bB]([01xXzZ]+)\s+([\s\S]+)$/g.exec(
              signalsObj.valueChange
            )
            if (!vMatches) {
              console.log('b error')
              signalsObj.valueChange = ''
            } else {
              // todo 未检测 refName 是否在 var 变量中
              if (signalsObj.currentTime) {
                // 把当前 valueChange 键值对存入对应时间下
                timeData[signalsObj.currentTime][vMatches[2]] = vMatches[1]
              }
            }
          } else if (
            signalsObj.valueChange.startsWith('r') ||
            signalsObj.valueChange.startsWith('R')
          ) {
            // r 类型
            const vMatches = /^[rR]([\s\S]+)\s+([\s\S]+)$/gm.exec(
              signalsObj.valueChange
            )
            if (!vMatches) {
              console.log('r error')
              signalsObj.valueChange = ''
            } else {
              // inf 情况单独列出
              let v: string | number = vMatches[1].toLowerCase()
              v = /[+-]*inf/gm.test(v) ? v : parseFloat(v)
              // 未检测 refName 是否在 var 变量中
              if (signalsObj.currentTime) {
                timeData[signalsObj.currentTime][vMatches[2]] = vMatches[1]
              }
            }
          } else if (/^[01xXzZ][\S]+$/g.test(signalsObj.valueChange)) {
            // 正常数字
            const vMatches = /^([01xXzZ])([\S]+)$/g.exec(signalsObj.valueChange)
            if (!vMatches) {
              console.log('number error')
              signalsObj.valueChange = ''
            } else {
              if (signalsObj.currentTime) {
                timeData[signalsObj.currentTime][vMatches[2]] = vMatches[1]
              }
            }
          } else {
            // 未列出的情况，出错
            console.log('parse var error')
          }
        }
        signalsObj.valueChange = ''
      } else signalsObj.valueChange += chunkString[index]
      index++
    }
  }
}
export default VCDParse
