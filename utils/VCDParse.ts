import fs from 'fs'
import { binarySearch } from './search'
import { Redis } from 'ioredis'
import conTire from './conTire'
import type { NestedArray } from './conTire'
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
    maxTime?: number
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
type TimeAndSignals = SignalsObjProps['timeData']
type Header = HeaderObjProps['header']
type Scale = {
  timeScale: number[]
  timeIndex: number[]
}

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
  async parseSacle(): Promise<Scale> {
    const scale: Scale = JSON.parse((await this.redis.get(this.path)) as string)
    if (scale) return Promise.resolve(scale)
    // timeSacle 与 timeIndex 一一对应，scale 存放时间刻度，index 存放该刻度对应的起始文件位置
    const rs = fs.createReadStream(this.path, {
        highWaterMark: 256 * 1024,
      }),
      timeScale: number[] = [],
      timeIndex: number[] = []
    let status = 0,
      timeStr = '',
      pastLen = 0,
      curLen = 0
    const start = process.hrtime.bigint()
    rs.on('data', (chunk: Buffer) => {
      const len = chunk.length
      let shouldBreak = false
      for (let i = 0; i < len; i++) {
        // 比直接用 chunk[i] 速度快
        const curChunkI = chunk[i]
        // switch 280ms 快于 if-else 350ms 快于 map 1300ms
        // caseMap.get(status)(curChunkI, i)
        switch (status) {
          // 初始状态
          case 0:
            if (curChunkI === 35) {
              status = 1
              curLen = i + pastLen
            } else {
              status = 3
            }
            // status = curChunkI === 35 ? 1 : 3
            break
          case 1:
            if (curChunkI >= 48 && curChunkI <= 57) {
              timeStr += String.fromCharCode(curChunkI)
              // 加数字后统一结算，没有直接加字符快
              // timeStr += curChunkI + ','
            } else if (curChunkI === 10) {
              timeScale.push(Number(timeStr))
              timeIndex.push(curLen)
              timeStr = ''
              status = 0
              shouldBreak = true
            } else {
              status = 3
              timeStr = ''
            }
            break
          case 3:
            if (curChunkI === 10) status = 0
            break

          default:
            break
        }
        if (shouldBreak) break
      }
      pastLen += len
    })
    // 返回 promise 供异步处理 signals
    return new Promise((resolve, reject) => {
      rs.on('end', async () => {
        const end = process.hrtime.bigint()
        const duration = (end - start) / BigInt(1000000) // 将纳秒转换为毫秒
        console.log(`parse scale2 耗时：${duration}ms`)
        resolve({ timeScale, timeIndex })
        await this.redis.set(
          this.path,
          JSON.stringify({ timeScale, timeIndex })
        )
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
  }

  async parseSignal(signal: string[]) {
    // 如果该文件时间刻度已存入 redis，则直接使用
    const scale: Scale = await this.parseSacle()
    // timeSacle 与 timeIndex 一一对应，scale 存放时间刻度，index 存放该刻度对应的起始文件位置
    // timeValue 存放对应时间下的信号的值
    const rs = fs.createReadStream(this.path, {
        highWaterMark: 256 * 1024,
        start: scale.timeIndex[0],
      }),
      signalHash: Record<string, Record<number, number>> = {},
      tire = conTire(signal)
    // pastLen 记录之前的 chunk 总长度，curLen 记录当前 time 所在文件位置
    let timeStr = '',
      curTime = 0,
      status = 0,
      curTire = [...tire],
      signalValue: number,
      tmpSignalV = '',
      signalName = ''
    signal.forEach((v) => {
      signalHash[v] = {}
    })
    const start = process.hrtime.bigint()
    rs.on('data', (chunk: Buffer) => {
      const len = chunk.length
      for (let i = 0; i < len; i++) {
        const curChunkI = chunk[i]
        switch (status) {
          // 初始状态
          case 0:
            switch (curChunkI) {
              case 35:
                status = 1
                break
              case 48:
              case 49:
                signalValue = Number(String.fromCharCode(curChunkI))
                status = 2
                break
              case 66:
              case 98:
                status = 4
                break
              case 10:
                break
              default:
                status = 3
                break
            }
            break
          // 找到 #
          case 1:
            switch (curChunkI) {
              case 48:
              case 49:
              case 50:
              case 51:
              case 52:
              case 53:
              case 54:
              case 55:
              case 56:
              case 57:
                timeStr += String.fromCharCode(curChunkI)
                break
              case 10:
                if (timeStr) {
                  curTime = Number(timeStr)
                  timeStr = ''
                }
                status = 0
                break
              default:
                status = 3
                timeStr = ''
                break
            }
            break
          // 找到 0/1
          case 2:
            // 使用字典树判断是否命中信号
            if (Array.isArray(curTire[curChunkI])) {
              signalName += String.fromCharCode(curChunkI)
              curTire = curTire[curChunkI] as NestedArray[]
              // console.log(curTire)
            } else if (curTire[curChunkI] === true) {
              // 记录当前信号名-信号值
              // console.log('换行', curChunkI)
              signalHash[signalName][curTime] = signalValue
              status = 0
              curTire = [...tire]
              signalName = ''
            } else {
              signalName = ''
              curTire = [...tire]
              status = 3
            }
            break
          // 直至换行
          case 3:
            if (curChunkI === 10) status = 0
            break
          // 找到 b/B 开头
          case 4:
            switch (curChunkI) {
              case 48:
              case 49:
                // 记录二进制值
                tmpSignalV += String.fromCharCode(curChunkI)
                break
              //  空格
              case 32:
                status = 5
                break
              // 换行
              case 10:
                status = 0
                tmpSignalV = ''
                break
              default:
                tmpSignalV = ''
                status = 3
                break
            }
            break
          // 判断向量信号
          case 5:
            // 使用字典树判断是否命中信号
            if (Array.isArray(curTire[curChunkI])) {
              signalName += String.fromCharCode(curChunkI)
              curTire = curTire[curChunkI] as NestedArray[]
            } else if (curTire[curChunkI] === true) {
              // 记录当前信号名-信号值
              signalHash[signalName][curTime] = parseInt(tmpSignalV, 2)
              status = 0
              curTire = [...tire]
              signalName = ''
              tmpSignalV = ''
            } else {
              signalName = ''
              tmpSignalV = ''
              curTire = [...tire]
              status = 3
            }
            break

          default:
            break
        }
      }
    })

    return new Promise((resolve, reject) => {
      rs.on('end', () => {
        const end = process.hrtime.bigint()
        const duration = (end - start) / BigInt(1000000) // 将纳秒转换为毫秒
        console.log(`parse signal 耗时：${duration}ms`)

        resolve(signalHash)
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
  }

  async parseSignals(t: number): Promise<TimeAndSignals> {
    const scale: Scale = await this.parseSacle()
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
    const startT = process.hrtime.bigint()
    rs.on('data', (chunk) => {
      this.#parseSignals(chunk.toString(), signalsObj)
    })
    // 返回异步处理后的 timeData
    return new Promise((resolve, reject) => {
      rs.on('end', () => {
        const endT = process.hrtime.bigint()
        const duration = (endT - startT) / BigInt(1000000) // 将纳秒转换为毫秒
        console.log(`parse signals 耗时：${duration}ms`)
        resolve(signalsObj.timeData)
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
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
    const start = process.hrtime.bigint()

    // 使用 promise 完成异步，关闭时再传出 header
    return new Promise((resolve, reject) => {
      rs.on('data', (chunk) => {
        this.#parseHeader(chunk.toString(), headerObj)
        if (headerObj.headerClose) rs.close()
      })
      rs.on('close', async () => {
        const maxTime = await this.#parseMaxTime()
        resolve({
          ...headerObj.header,
          maxTime,
        })
        const end = process.hrtime.bigint()
        const duration = (end - start) / BigInt(1000000) // 将纳秒转换为毫秒
        console.log(`parse header 耗时：${duration}ms`)
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
            .split(/\s+/g)
          // 将 signal 值存入 signalsOfModule 对应键中
          header.signalsOfModule[moduleStack[moduleStack.length - 1]].push(
            signalSplit[0] +
              ' ' +
              signalSplit[1] +
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

  async #parseMaxTime(): Promise<number> {
    const scale: Scale = await this.parseSacle()
    const rs = fs.createReadStream(this.path, {
      highWaterMark: 256 * 1024,
      start: scale.timeIndex[scale.timeScale.length - 1],
    })
    let status = 0,
      maxTime = 0,
      timeStr = ''
    const start = process.hrtime.bigint()
    rs.on('data', (chunk: Buffer) => {
      for (const curChunkI of chunk) {
        // 初始状态
        if (status === 0) {
          status = curChunkI === 35 ? 1 : 3
        } else if (status === 1) {
          if (curChunkI >= 48 && curChunkI <= 57) {
            timeStr += String.fromCharCode(curChunkI)
          } else if (curChunkI === 10) {
            const time = Number(timeStr)
            if (!Number.isNaN(time)) {
              maxTime = time
            }
            timeStr = ''
            status = 0
          } else {
            status = 3
            timeStr = ''
          }
        } else if (status === 3) {
          if (curChunkI === 10) status = 0
        }
      }
    })
    return new Promise((resolve, reject) => {
      rs.on('end', () => {
        const end = process.hrtime.bigint()
        const duration = (end - start) / BigInt(1000000) // 将纳秒转换为毫秒
        console.log(`parse max time 耗时：${duration}ms`)
        resolve(maxTime)
      })
      rs.on('error', (err) => {
        reject(err)
      })
    })
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
