var fs = require('fs-extra')
var path = require('path')
var {DOMParser} =  require('xmldom')
var exec = require('child_process').exec
var pug = require('pug')
var less = require('less')
var chokidar = require('chokidar')
var commander = require('commander')
var colors = require('colors/safe')

colors.setTheme({
  '变更': 'blue',
  '删除': 'bgMagenta',
  '执行': 'blue',
  '信息': 'grey',
  '创建': 'green',
  '监听': 'magenta',
  '错误': 'red',
  '测试': 'red',
  '拷贝': 'yellow',
  '编译': 'green',
  '写入': 'green'
})

// 处理 npm 包
function handleNPM (jsCode) {
  var deps = []
  jsCode.replace(/require\(['"](.*?)['"]\)/g, (a, b) => {
    deps.push(b)
  })

  deps.forEach(dep => {
    var isNPM = dep.includes('/npm/')
    
    if (isNPM){
      var npmName = path.basename(dep).split('.')[0]

      // 查 npmName/dist/{npmName}.js
      var distPath = path.join(modulesPath, npmName, `dist/${npmName}.js`)
      // 查 npmName/index.js
      var indexPath = path.join(modulesPath, npmName, `index.js`)
      // 查 npmName/npmName.js
      var npmNamePath = path.join(modulesPath, npmName, `${npmName}.js`)

      // 是否查到
      var hasNPM = false
      ;[distPath, indexPath, npmNamePath].some(p => {
        if (fs.existsSync(p)){
          copyFile(p, path.join(npmPath, `${npmName}.js`))
          hasNPM = true
          return true
        }
      })

      if (!hasNPM){
        error(`没有找到 ${dep}`)
      }
    }
  })
}

// 获取版本号
function getVersion () {
  var packagePath = path.resolve(__dirname, 'package.json')
  return JSON.parse(fs.readFileSync(packagePath)).version
}

// 获取当前时间
function datetime (date = new Date(), format = 'HH:mm:ss') {
  var fn = (d) => {
    return ('0' + d).slice(-2)
  }
  var formats = {
      YYYY: date.getFullYear(),
      MM: fn(date.getMonth() + 1),
      DD: fn(date.getDate()),
      HH: fn(date.getHours()),
      mm: fn(date.getMinutes()),
      ss: fn(date.getSeconds())
  }
  return format.replace(/([a-z])\1+/ig, function (a) {
      return formats[a] || a
  })
}

// 打日志
function log (msg, type, showTime = true) {
  var time = showTime ? colors.gray(`[${datetime()}]`) : ''
  if (type === 'ERROR'){
    console.error(time + colors.red('[Error]' + msg))
  }
  else if (type === 'WARNING'){
    console.error(time + colors.yellow('[Warning]') + msg)
  }
  else {
    var fn = colors[type] ? colors[type] : colors['info'];
    console.log(time + fn(`[${type}]` + msg))
  }
}

function error (msg) {
  log(msg, 'ERROR')
}

function warning (msg) {
  log(msg, 'WARNING')
}

// 创建文件
function createFile (f, body) {
  var arr = f.split('/')
  var len = arr.length
  var i = 0
  var a = '/'
  var b

  while ( (b = arr.shift()) != null ){
      i++
      a = path.join(a, b)
      //如果b是最后一项，并且有body
      if ( (typeof body != 'undefined') &&  (i == len) ){
          fs.writeFileSync(a, body.toString())
      }
      else {
          if (!fs.existsSync(a)){
              fs.mkdirSync(a)
          }
      }
  }
}

// 复制文件
function copyFile (f1, f2) {
  return new Promise((resolve, reject) => {
    fs.copy(f1, f2, err => {
      if (err){
        reject(err)
      }else {
        resolve()
      }
    })
  })
}

// 删除文件
function removeFile (f) {
  return new Promise((resolve, reject) => {
    exec(`rm -rf ${f}`).stdout.on('end', _=>{
      resolve()
    })
  })
}

// 深度遍历目录
function walk (dir, callback) {
  fs.readdirSync(dir).forEach(item => {
      //忽略隐藏文件
      if (item[0] == '.'){
          return false
      }

      var f = path.join(dir, item)
      if (fs.statSync(f).isDirectory()){
          walk(f, callback)
      }
      else {
          callback(f)
      }
  })
}

function makeNodesArray (nodes) {
  return [].slice.call(nodes || [])
}

// 拆解wpy文件
function splitWpy (filePath) {
  var content = fs.readFileSync(filePath).toString()
  var doc = new DOMParser().parseFromString(content)
  var tags = 'style,template,script,config'.split(',')

  var codes = {}
  tags.forEach(tag => {
    codes[tag] = ''
  })

  makeNodesArray(doc.childNodes).forEach( node => {
    var nodeName = node.nodeName

    if (tags.includes(nodeName)){
      makeNodesArray(node.childNodes).forEach(node2 => {
        codes[nodeName] = (codes[nodeName] || '') + node2.toString()
      })
    }
  })

  // 处理 js 代码
  if (codes.script){
    handleNPM(codes.script)
  }

  // 处理 pug 代码
  if (codes.template){
    codes.template = pug.compile(codes.template)({})
  }

  // 处理 less 代码，异步的，返回 promise
  return new Promise((resolve, reject) => {
    less.render(codes.style, (e, output) => {
      if (e){
        error(e)
        reject(e)
      }
      else {
        // 添加依赖
        output.imports.forEach(importPath => {
          var lessPath = path.join(rootPath, importPath)
          lessDepTable[lessPath] = filePath
        })
        codes.style = output.css
        resolve(codes)
      }
    })
  })
}

// 根据codes生成dist/page/x/x.wxml, x.wxs, x.wxss, x.json
function createDistPage (pageName, codes) {
  createFile(path.join(distPath, 'pages', pageName + '.wxml'), codes.template)
  createFile(path.join(distPath, 'pages', pageName + '.js'), codes.script)
  createFile(path.join(distPath, 'pages', pageName + '.wxss'), codes.style)
  createFile(path.join(distPath, 'pages', pageName + '.json'), codes.config)
}

// 处理wpy文件
function handleWpy (filePath) {
  var pageName = path.basename(filePath).split('.')[0]
  splitWpy(filePath).then(codes => {
    createDistPage(pageName, codes)
  })
}

// 处理文件
function handleFile (filePath, isWatch) {
  var extname = path.extname(filePath)
  var relativePath = path.relative(srcPath, filePath)

  if (extname === '.wpy'){
    log('文件：' + relativePath, '编译')
    handleWpy(filePath)
  }

  // 如果是原生文件，直接 copy
  else if (['.js', '.json', '.wxml', '.wxs', '.wxss'].includes(extname)) {
    log('文件：' + relativePath, '拷贝')
    copyFile(filePath, path.join(distPath, relativePath))

    // 如果是 js，检查 npm 包
    if (extname === '.js'){
      handleNPM(fs.readFileSync(filePath).toString())
    }
  }

  // 如果是 less, 检查依赖
  else if ( (extname === '.less') && isWatch){
    log('文件：' + relativePath, '变更')
    if (filePath in lessDepTable){
      handleFile(lessDepTable[filePath])
    }
  }

  // 其他文件一律抛弃
  else {}
}

function watch () {
  var watchReady = false

  chokidar.watch(srcPath, {
    // ignored: /\.git/,
  })
  .on('all', (evt, filePath) => {
    if ( (evt === 'change' || evt === 'add') && watchReady){
      handleFile(filePath, true)
    }
  })
  .on('ready', () => {
    watchReady = true
    log('开始监听文件改动...', '监听')
  })
}

function handle () {
  // 清空dist
  removeFile(distPath).then(_ => {
    // 遍历 src 目录
    walk(srcPath, filePath => {
      handleFile(filePath)
    })
  })
}

// # 主流程
var rootPath = process.cwd()
var srcPath = path.join(rootPath, 'src')
var distPath = path.join(rootPath, 'dist')
var npmPath = path.join(distPath, 'npm')
var modulesPath = path.join(rootPath, 'node_modules')

// 依赖表{.less : .wpy}
var lessDepTable = {}

commander.usage('[command] <options ...>')
commander.option('-v, --version', '显示版本号', () => {
  console.log(getVersion())
})
commander.option('-w, --watch', '监听文件改动')

commander.command('build').description('编译项目').action( () => {
  handle()
  if (commander.watch){
    watch()
  }
})

commander.parse(process.argv)