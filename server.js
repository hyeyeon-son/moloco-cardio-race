const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 9000;

// 데이터 파일 경로
const DATA_FILE = path.join(__dirname, 'data', 'records.json');
const LOCK_FILE = path.join(__dirname, 'data', 'records.lock');

// 데이터 폴더 생성
if (!fs.existsSync('data')) {
  fs.mkdirSync('data', { recursive: true });
}

// 파일 잠금 관리 클래스
class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile;
    this.isLocked = false;
  }

  async acquire() {
    const maxRetries = 50;
    const retryDelay = 100;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        // 락 파일이 존재하지 않으면 생성 (atomic operation)
        fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' });
        this.isLocked = true;
        return;
      } catch (error) {
        if (error.code === 'EEXIST') {
          // 락 파일이 존재함 - 잠시 대기 후 재시도
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          throw error;
        }
      }
    }
    throw new Error('Failed to acquire file lock');
  }

  release() {
    if (this.isLocked) {
      try {
        fs.unlinkSync(this.lockFile);
        this.isLocked = false;
      } catch (error) {
        console.error('Error releasing lock:', error);
      }
    }
  }
}

// 데이터 읽기 함수
function readRecords() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return {
        records: parsed.records || [],
        nextId: parsed.nextId || 1
      };
    }
  } catch (error) {
    console.error('Error reading records:', error);
  }
  return { records: [], nextId: 1 };
}

// 데이터 쓰기 함수 (락 사용)
async function writeRecords(records, nextId) {
  const lock = new FileLock(LOCK_FILE);
  
  try {
    await lock.acquire();
    
    const data = {
      records: records,
      nextId: nextId,
      lastUpdated: new Date().toISOString()
    };
    
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Records saved: ${records.length} records, nextId: ${nextId}`);
    
  } catch (error) {
    console.error('Error writing records:', error);
    throw error;
  } finally {
    lock.release();
  }
}

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 제공 (HTML, CSS, JS)
app.use(express.static('public'));

// 파일 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${timestamp}_${Math.random().toString(36).substr(2, 9)}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB 제한
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('이미지 파일만 업로드 가능합니다.'));
    }
  }
});

// 로컬 IP 주소 가져오기
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        return interface.address;
      }
    }
  }
  return 'localhost';
}

// 기본 라우트 - HTML 파일 제공
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      message: 'MOLOCO CARDIO RACE 랭킹 서버',
      version: '2.0.0',
      note: 'public/index.html 파일을 생성해주세요.',
      endpoints: {
        'POST /api/submit-record': '기록 제출',
        'GET /api/rankings': '성별 분리 랭킹 조회',
        'GET /api/my-record/:name': '개인 기록 조회',
        'GET /api/statistics': '통계 조회',
        'GET /api/backup': '데이터 백업'
      }
    });
  }
});

// API 정보 라우트
app.get('/api', (req, res) => {
  res.json({
    message: 'MOLOCO CARDIO RACE API',
    version: '2.0.0',
    endpoints: {
      'POST /api/submit-record': '기록 제출',
      'GET /api/rankings': '성별 분리 랭킹 조회',
      'GET /api/my-record/:name': '개인 기록 조회',
      'GET /api/statistics': '통계 조회',
      'GET /api/backup': '데이터 백업'
    }
  });
});

// 기록 제출 API
app.post('/api/submit-record', upload.single('photo'), async (req, res) => {
  try {
    const { name, gender, bike, treadmill, rowing } = req.body;
    
    // 필수 필드 검증
    if (!name || !gender || !bike || !treadmill || !rowing) {
      return res.status(400).json({
        success: false,
        message: '모든 필드를 입력해주세요.'
      });
    }

    // 사진 업로드 검증
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '증빙 사진을 업로드해주세요.'
      });
    }

    // 현재 데이터 읽기
    const { records, nextId } = readRecords();

    // 기록 데이터 생성
    const record = {
      id: nextId,
      name,
      gender,
      bike: parseFloat(bike),
      treadmill: parseFloat(treadmill),
      rowing: parseFloat(rowing),
      totalDistance: parseFloat(bike) + parseFloat(treadmill) + parseFloat(rowing),
      photoPath: req.file.path,
      submittedAt: new Date().toISOString()
    };

    // 새 기록 추가
    records.push(record);

    // 파일에 저장 (락 사용)
    await writeRecords(records, nextId + 1);

    // 성별별 순위 계산
    const sameGenderRecords = records.filter(r => r.gender === gender);
    sameGenderRecords.sort((a, b) => b.totalDistance - a.totalDistance);
    
    // 현재 제출자의 성별별 순위 찾기
    const currentRank = sameGenderRecords.findIndex(r => r.id === record.id) + 1;

    res.json({
      success: true,
      message: '기록이 성공적으로 제출되었습니다.',
      data: {
        rank: currentRank,
        totalParticipants: records.length,
        genderParticipants: sameGenderRecords.length,
        gender: gender === 'male' ? '남성' : '여성'
      }
    });

  } catch (error) {
    console.error('기록 제출 오류:', error);
    res.status(500).json({
      success: false,
      message: '서버 오류가 발생했습니다.'
    });
  }
});

// 랭킹 조회 API (성별 분리 버전)
app.get('/api/rankings', (req, res) => {
  try {
    // 파일에서 데이터 읽기
    const { records } = readRecords();
    
    // 성별로 분리
    const maleRecords = records.filter(record => record.gender === 'male');
    const femaleRecords = records.filter(record => record.gender === 'female');
    
    // 각 성별 내에서 총 거리 기준으로 정렬
    const sortedMaleRecords = maleRecords.sort((a, b) => b.totalDistance - a.totalDistance);
    const sortedFemaleRecords = femaleRecords.sort((a, b) => b.totalDistance - a.totalDistance);
    
    // 남성 랭킹 생성 (기록 블러 처리)
    const maleRankings = sortedMaleRecords.map((record, index) => ({
      rank: index + 1,
      name: record.name,
      gender: record.gender,
      bike: '***',
      treadmill: '***',
      rowing: '***',
      totalDistance: '***',
      submittedAt: record.submittedAt.split('T')[0]
    }));
    
    // 여성 랭킹 생성 (기록 블러 처리)
    const femaleRankings = sortedFemaleRecords.map((record, index) => ({
      rank: index + 1,
      name: record.name,
      gender: record.gender,
      bike: '***',
      treadmill: '***',
      rowing: '***',
      totalDistance: '***',
      submittedAt: record.submittedAt.split('T')[0]
    }));

    // 각 성별 1등 기록 정보
    const maleFirstPlace = sortedMaleRecords.length > 0 ? {
      name: sortedMaleRecords[0].name,
      gender: sortedMaleRecords[0].gender,
      bike: sortedMaleRecords[0].bike,
      treadmill: sortedMaleRecords[0].treadmill,
      rowing: sortedMaleRecords[0].rowing,
      totalDistance: sortedMaleRecords[0].totalDistance,
      submittedAt: sortedMaleRecords[0].submittedAt.split('T')[0]
    } : null;

    const femaleFirstPlace = sortedFemaleRecords.length > 0 ? {
      name: sortedFemaleRecords[0].name,
      gender: sortedFemaleRecords[0].gender,
      bike: sortedFemaleRecords[0].bike,
      treadmill: sortedFemaleRecords[0].treadmill,
      rowing: sortedFemaleRecords[0].rowing,
      totalDistance: sortedFemaleRecords[0].totalDistance,
      submittedAt: sortedFemaleRecords[0].submittedAt.split('T')[0]
    } : null;

    res.json({
      success: true,
      data: {
        maleRankings,
        femaleRankings,
        totalParticipants: records.length,
        maleParticipants: maleRecords.length,
        femaleParticipants: femaleRecords.length,
        maleFirstPlace,
        femaleFirstPlace
      }
    });

  } catch (error) {
    console.error('랭킹 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '서버 오류가 발생했습니다.'
    });
  }
});

// 개인 기록 조회 API (본인 확인 후)
app.get('/api/my-record/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { records } = readRecords();
    
    const userRecords = records.filter(r => r.name === name);
    
    if (userRecords.length === 0) {
      return res.status(404).json({
        success: false,
        message: '해당 이름의 기록을 찾을 수 없습니다.'
      });
    }

    // 최신 기록 반환
    const latestRecord = userRecords[userRecords.length - 1];
    
    // 성별별 순위 계산
    const sameGenderRecords = records.filter(r => r.gender === latestRecord.gender);
    const sortedSameGenderRecords = sameGenderRecords.sort((a, b) => b.totalDistance - a.totalDistance);
    const rank = sortedSameGenderRecords.findIndex(r => r.id === latestRecord.id) + 1;

    res.json({
      success: true,
      data: {
        rank,
        record: {
          name: latestRecord.name,
          gender: latestRecord.gender,
          bike: latestRecord.bike,
          treadmill: latestRecord.treadmill,
          rowing: latestRecord.rowing,
          totalDistance: latestRecord.totalDistance,
          submittedAt: latestRecord.submittedAt
        },
        totalParticipants: records.length,
        genderParticipants: sameGenderRecords.length
      }
    });

  } catch (error) {
    console.error('개인 기록 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '서버 오류가 발생했습니다.'
    });
  }
});

// 통계 조회 API
app.get('/api/statistics', (req, res) => {
  try {
    const { records } = readRecords();
    
    const totalParticipants = records.length;
    const maleCount = records.filter(r => r.gender === 'male').length;
    const femaleCount = records.filter(r => r.gender === 'female').length;
    
    const totalDistances = records.map(r => r.totalDistance);
    const avgDistance = totalDistances.length > 0 
      ? totalDistances.reduce((sum, dist) => sum + dist, 0) / totalDistances.length 
      : 0;
    
    const maxDistance = totalDistances.length > 0 ? Math.max(...totalDistances) : 0;

    res.json({
      success: true,
      data: {
        totalParticipants,
        maleCount,
        femaleCount,
        averageDistance: Math.round(avgDistance * 100) / 100,
        maxDistance: Math.round(maxDistance * 100) / 100
      }
    });

  } catch (error) {
    console.error('통계 조회 오류:', error);
    res.status(500).json({
      success: false,
      message: '서버 오류가 발생했습니다.'
    });
  }
});

// 데이터 백업 API (관리자용)
app.get('/api/backup', (req, res) => {
  try {
    const { records } = readRecords();
    const backupData = {
      records,
      backupTime: new Date().toISOString(),
      totalRecords: records.length,
      version: '2.0.0'
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="cardio-race-backup.json"');
    res.send(JSON.stringify(backupData, null, 2));
    
  } catch (error) {
    console.error('백업 오류:', error);
    res.status(500).json({
      success: false,
      message: '백업 생성 중 오류가 발생했습니다.'
    });
  }
});

// 정적 파일 제공 (업로드된 이미지)
app.use('/uploads', express.static('uploads'));

// 에러 핸들링 미들웨어
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: '파일 크기가 너무 큽니다. (최대 10MB)'
      });
    }
  }
  
  console.error('서버 오류:', error);
  res.status(500).json({
    success: false,
    message: '서버 오류가 발생했습니다.'
  });
});

// 서버 시작 - 모든 네트워크 인터페이스에서 접속 허용
app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIPAddress();
  
  console.log(`🚀 MOLOCO CARDIO RACE 서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`\n📱 접속 주소:`);
  console.log(`   로컬: http://localhost:${PORT}`);
  console.log(`   네트워크: http://${localIP}:${PORT}`);
  console.log(`\n🌐 같은 Wi-Fi 네트워크의 다른 기기에서도 접속 가능합니다!`);
  console.log(`🔧 API 엔드포인트: http://${localIP}:${PORT}/api`);
  console.log(`💾 데이터 저장: ${DATA_FILE}`);
  console.log(`🔒 락 파일: ${LOCK_FILE}`);
  
  // 초기 데이터 파일 생성
  const { records } = readRecords();
  console.log(`📊 현재 저장된 기록: ${records.length}개`);
  
  // public 폴더 체크
  if (!fs.existsSync('public')) {
    console.log('\n⚠️  public 폴더가 없습니다. 다음 명령어를 실행하세요:');
    console.log('   mkdir public');
    console.log('   그리고 index.html을 public 폴더에 넣어주세요.');
  }
});

module.exports = app;